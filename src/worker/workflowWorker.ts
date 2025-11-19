import { Worker, Job } from 'bullmq';
import { Durabull } from '../config/global';
import { getStorage } from '../runtime/storage';
import { Redis } from 'ioredis';
import { createLoggerFromConfig } from '../runtime/logger';
import { initQueues } from '../queues';
import { ReplayEngine } from '../runtime/ReplayEngine';

/**
 * Job data for workflow execution
 */
interface WorkflowJobData {
  workflowId: string;
  workflowName?: string;
  args?: unknown[];
  isResume?: boolean;
  timerId?: string;
}

/**
 * Start the workflow worker
 */
export function startWorkflowWorker(instance?: Durabull): Worker {
  const durabullInstance = instance || Durabull.getActive();
  if (!durabullInstance) {
    throw new Error('Durabull instance not initialized. Call new Durabull(config) first or pass instance to startWorkflowWorker.');
  }
  const initialConfig = durabullInstance.getConfig();
  const storage = getStorage();
  
  // Initialize queues if not already initialized
  initQueues(
    initialConfig.redisUrl,
    initialConfig.queues.workflow,
    initialConfig.queues.activity
  );
  
  const logger = createLoggerFromConfig(initialConfig.logger);
  
  const connection = new Redis(initialConfig.redisUrl, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker(
    initialConfig.queues.workflow,
    async (job: Job<WorkflowJobData>) => {
      const config = durabullInstance.getConfig();
      const { workflowId, workflowName, isResume = false, timerId } = job.data;

      logger.info(`[WorkflowWorker] Processing workflow ${workflowId} (${workflowName || 'unknown'}) (resume: ${isResume})`);

      const lockAcquired = await storage.acquireLock(workflowId, 'workflow', 300);
      if (!lockAcquired) {
        logger.debug(`[WorkflowWorker] Workflow ${workflowId} is already running, skipping`);
        return;
      }

      if (isResume && timerId) {
        await storage.appendEvent(workflowId, {
          type: 'timer-fired',
          id: timerId,
          ts: Date.now(),
        });
      }

      try {
        let record = await storage.readRecord(workflowId);
        if (!record) {
          throw new Error(`Workflow ${workflowId} not found`);
        }

        const readHistory = async () =>
          (await storage.readHistory(workflowId)) || { events: [], cursor: 0 };
        const history = await readHistory();

        if (record.status === 'completed' || record.status === 'failed') {
          logger.debug(`[WorkflowWorker] Workflow ${workflowId} already ${record.status}`);
          return;
        }

        const resolvedWorkflowName = workflowName || record.class;
        const WorkflowClass = durabullInstance.resolveWorkflow(resolvedWorkflowName);
        if (!WorkflowClass) {
          throw new Error(`Workflow "${resolvedWorkflowName}" not registered`);
        }

        const previousWaiting = record.waiting ? { ...record.waiting } : undefined;

        record.status = 'running';
        record.waiting = undefined;
        record.updatedAt = Date.now();
        await storage.writeRecord(record);

        if (previousWaiting) {
          record.waiting = previousWaiting;
        }

        const workflow = new WorkflowClass();
        const signals = await storage.listSignals(workflowId);

        const replayResult = await ReplayEngine.run({
          workflowId,
          workflow,
          record,
          history,
          signals,
          isResume,
          getHistory: readHistory,
          onStep: async (cursor, updatedHistory) => {
            await storage.writeHistory(workflowId, updatedHistory);
          },
        });

        if (replayResult.signalCursor) {
          const latestRecord = await storage.readRecord(workflowId);
          if (latestRecord) {
            latestRecord.signalCursor = replayResult.signalCursor;
            latestRecord.updatedAt = Date.now();
            await storage.writeRecord(latestRecord);
            record = latestRecord;
          }
        }

        if (replayResult.status === 'completed') {
          record = (await storage.readRecord(workflowId)) ?? record;
          if (!record) {
            throw new Error(`Workflow ${workflowId} record missing during completion`);
          }

          record.status = 'completed';
          record.output = replayResult.result;
          record.waiting = undefined;
          record.updatedAt = Date.now();
          await storage.writeRecord(record);

          if (config.lifecycleHooks?.workflow?.onComplete) {
            try {
              await config.lifecycleHooks.workflow.onComplete(workflowId, resolvedWorkflowName, replayResult.result);
            } catch (hookError) {
              logger.error('Workflow onComplete hook failed', hookError);
            }
          }

          logger.info(`[WorkflowWorker] Workflow ${workflowId} completed`);

        } else if (replayResult.status === 'failed') {
          const failedRecord = await storage.readRecord(workflowId);
          if (failedRecord) {
            failedRecord.status = 'failed';
            failedRecord.error = {
              message: (replayResult.error as Error).message,
              stack: (replayResult.error as Error).stack,
            };
            failedRecord.waiting = undefined;
            failedRecord.updatedAt = Date.now();
            await storage.writeRecord(failedRecord);
            
            if (config.lifecycleHooks?.workflow?.onFailed) {
              try {
                await config.lifecycleHooks.workflow.onFailed(workflowId, resolvedWorkflowName, replayResult.error as Error);
              } catch (hookError) {
                logger.error('Workflow onFailed hook failed', hookError);
              }
            }
          }
          logger.error(`[WorkflowWorker] Workflow ${workflowId} failed`, replayResult.error);
          throw replayResult.error;

        } else if (replayResult.status === 'waiting') {
          const waitingRecord = await storage.readRecord(workflowId);
          if (waitingRecord) {
            waitingRecord.status = 'waiting';
            waitingRecord.updatedAt = Date.now();
            await storage.writeRecord(waitingRecord);
          }

          if (config.lifecycleHooks?.workflow?.onWaiting) {
            try {
              await config.lifecycleHooks.workflow.onWaiting(workflowId, resolvedWorkflowName);
            } catch (hookError) {
              logger.error('Workflow onWaiting hook failed', hookError);
            }
          }
          
          logger.debug(`[WorkflowWorker] Workflow ${workflowId} waiting`);

        } else if (replayResult.status === 'continued') {
          if (config.lifecycleHooks?.workflow?.onContinued) {
            try {
              await config.lifecycleHooks.workflow.onContinued(workflowId, resolvedWorkflowName, replayResult.newWorkflowId!);
            } catch (hookError) {
              logger.error('Workflow onContinued hook failed', hookError);
            }
          }
          
          logger.info(
            `[WorkflowWorker] Workflow ${workflowId} continued as new -> ${replayResult.newWorkflowId}`
          );
        }

      } catch (error) {
        logger.error(`[WorkflowWorker] Unexpected error in workflow ${workflowId}`, error);
        throw error;
      } finally {
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

  worker.on('closed', async () => {
    await connection.quit();
    logger.info('[WorkflowWorker] Connection closed');
  });

  logger.info('[WorkflowWorker] Started');
  return worker;
}
