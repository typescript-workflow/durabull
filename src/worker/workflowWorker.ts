/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Workflow worker implementation
 * 
 * Logs are routed through the configurable Durabull logger hook for observability.
 */

import { Worker, Job } from 'bullmq';
import { Durabull } from '../config/global';
import { getStorage } from '../runtime/storage';
import { WorkflowRecord, HistoryEvent } from '../runtime/history';
import { Redis } from 'ioredis';
import { WorkflowStub, WorkflowWaitError, WorkflowContinueAsNewError } from '../WorkflowStub';
import { getSignalMethods } from '../decorators';
import { getLogger } from '../runtime/logger';

/**
 * Workflow registry - maps class names to constructors
 */
const workflowRegistry = new Map<string, new () => any>();

/**
 * Register a workflow class
 */
export function registerWorkflow(name: string, WorkflowClass: new () => any): void {
  workflowRegistry.set(name, WorkflowClass);
}

/**
 * Resolve workflow class by name
 */
export function resolveWorkflow(name: string): (new () => any) | null {
  return workflowRegistry.get(name) || null;
}

const isPromiseLike = <T = unknown>(value: unknown): value is PromiseLike<T> => {
  return Boolean(value) && typeof (value as any).then === 'function';
};

/**
 * Job data for workflow execution
 */
interface WorkflowJobData {
  workflowId: string;
  args?: any[];
  isResume?: boolean;
}

/**
 * Start the workflow worker
 */
export function startWorkflowWorker(): Worker {
  const config = Durabull.getConfig();
  const storage = getStorage();
  const logger = getLogger();
  
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker(
    config.queues!.workflow!,
    async (job: Job<WorkflowJobData>) => {
      const { workflowId, args = [], isResume = false } = job.data;

  logger.info(`[WorkflowWorker] Processing workflow ${workflowId} (resume: ${isResume})`);

      // Acquire lock to prevent concurrent execution
      const lockAcquired = await storage.acquireLock(workflowId, 'workflow', 300);
      if (!lockAcquired) {
  logger.debug(`[WorkflowWorker] Workflow ${workflowId} is already running, skipping`);
        return;
      }

      let record: WorkflowRecord | null = null;
      let signalCursor: Record<string, number> = {};
      let signalCursorDirty = false;

      const persistSignalCursor = async () => {
        if (!signalCursorDirty) {
          return;
        }

        const latestRecord = await storage.readRecord(workflowId);
        if (!latestRecord) {
          return;
        }

        latestRecord.signalCursor = { ...signalCursor };
        latestRecord.updatedAt = Date.now();
        await storage.writeRecord(latestRecord);
        record = latestRecord;
        signalCursorDirty = false;
      };

      try {
        record = await storage.readRecord(workflowId);
        if (!record) {
          throw new Error(`Workflow ${workflowId} not found`);
        }

        const readHistory = async () =>
          (await storage.readHistory(workflowId)) || { events: [], cursor: 0 };
        let history = await readHistory();

        if (record.status === 'completed' || record.status === 'failed') {
          logger.debug(`[WorkflowWorker] Workflow ${workflowId} already ${record.status}`);
          return;
        }

        const WorkflowClass = resolveWorkflow(record.class);
        if (!WorkflowClass) {
          throw new Error(`Workflow class ${record.class} not registered`);
        }

        const effectiveArgs = args.length ? args : record.args ?? [];
        const previousWaiting = record.waiting ? { ...record.waiting } : undefined;

        record.status = 'running';
        record.waiting = undefined;
        record.updatedAt = Date.now();
        await storage.writeRecord(record);

        if (previousWaiting) {
          record.waiting = previousWaiting;
        }

        const workflow = new WorkflowClass();

        WorkflowStub._setContext({
          workflowId,
          workflow,
          record,
          isResume,
          clockCursor: 0,
        });

        const signalMethods = getSignalMethods(WorkflowClass);
        signalCursor = { ...(record.signalCursor ?? {}) };

        const replaySignals = async (
          index: number,
          options: { initial: boolean; log?: HistoryEvent; nextLog?: HistoryEvent }
        ): Promise<void> => {
          if (signalMethods.length === 0) {
            return;
          }

          const signals = await storage.listSignals(workflowId);
          if (!signals.length) {
            return;
          }

          const sortedSignals = [...signals].sort((a, b) => a.ts - b.ts);
          const key = index.toString();

          if (!options.initial && !options.log) {
            return;
          }

          let lowerBound = signalCursor[key] ?? Number.NEGATIVE_INFINITY;
          if (options.log) {
            lowerBound = Math.max(lowerBound, options.log.ts ?? Number.NEGATIVE_INFINITY);
          }

          const upperBound = options.nextLog ? options.nextLog.ts : Number.POSITIVE_INFINITY;

          const toReplay = sortedSignals.filter(
            (signal) => signal.ts > lowerBound && signal.ts <= upperBound
          );

          if (!toReplay.length) {
            return;
          }

          for (const signal of toReplay) {
            if (signalMethods.includes(signal.name)) {
              const argsForSignal = Array.isArray(signal.payload)
                ? signal.payload
                : [signal.payload];
              (workflow as any)[signal.name](...argsForSignal);
            }
          }

          signalCursor[key] = toReplay[toReplay.length - 1].ts;
          signalCursorDirty = true;
        };

        let currentIndex = history.cursor ?? 0;

        const getLogsForIndex = async (
          index: number
        ): Promise<{ log?: HistoryEvent; nextLog?: HistoryEvent }> => {
          history = await readHistory();
          return {
            log: history.events[index],
            nextLog: history.events[index + 1],
          };
        };

        const initialLogs = await getLogsForIndex(currentIndex);
        await replaySignals(currentIndex, { initial: true, ...initialLogs });

        const generator = workflow.execute(...effectiveArgs);

        let result = await generator.next();

        while (!result.done) {
          const { log, nextLog } = await getLogsForIndex(currentIndex);
          await replaySignals(currentIndex, { initial: false, log, nextLog });

          if (isPromiseLike(result.value)) {
            try {
              const resolved = await result.value;

              currentIndex += 1;
              history.cursor = currentIndex;
              await storage.writeHistory(workflowId, history);

              result = await generator.next(resolved);
            } catch (error) {
              if (error instanceof WorkflowContinueAsNewError) {
                await persistSignalCursor();
                logger.info(
                  `[WorkflowWorker] Workflow ${workflowId} continued as new -> ${error.workflowId}`
                );
                return;
              }

              if (error instanceof WorkflowWaitError) {
                await persistSignalCursor();
                logger.debug(`[WorkflowWorker] Workflow ${workflowId} waiting`);
                return;
              }

              result = await generator.throw(error);
            }
          } else {
            currentIndex += 1;
            history.cursor = currentIndex;
            await storage.writeHistory(workflowId, history);

            result = await generator.next(result.value);
          }
        }

        await persistSignalCursor();

        record = (await storage.readRecord(workflowId)) ?? record;
        if (!record) {
          throw new Error(`Workflow ${workflowId} record missing during completion`);
        }

        record.status = 'completed';
        record.output = result.value;
        record.waiting = undefined;
        record.signalCursor = { ...signalCursor };
        record.updatedAt = Date.now();
        await storage.writeRecord(record);

  logger.info(`[WorkflowWorker] Workflow ${workflowId} completed`);
      } catch (error) {
        if (error instanceof WorkflowContinueAsNewError) {
          await persistSignalCursor();
          logger.info(
            `[WorkflowWorker] Workflow ${workflowId} continued as new -> ${error.workflowId}`
          );
          return;
        }

        if (error instanceof WorkflowWaitError) {
          await persistSignalCursor();
          logger.debug(`[WorkflowWorker] Workflow ${workflowId} waiting`);
          return;
        }

        await persistSignalCursor();

        const failedRecord = await storage.readRecord(workflowId);
        if (failedRecord) {
          failedRecord.status = 'failed';
          failedRecord.error = {
            message: (error as Error).message,
            stack: (error as Error).stack,
          };
          failedRecord.waiting = undefined;
          failedRecord.updatedAt = Date.now();
          await storage.writeRecord(failedRecord);
        }

  logger.error(`[WorkflowWorker] Workflow ${workflowId} failed`, error);
        throw error;
      } finally {
        await persistSignalCursor();
        WorkflowStub._setContext(null);
        // Release lock
        await storage.releaseLock(workflowId, 'workflow');
      }
    },
    { connection }
  );

  worker.on('completed', (job: Job) => {
    logger.info(`[WorkflowWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(`[WorkflowWorker] Job ${job?.id} failed`, err);
  });

  logger.info('[WorkflowWorker] Started');
  return worker;
}
