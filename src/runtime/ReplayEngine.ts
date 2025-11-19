import { Workflow } from '../Workflow';
import { WorkflowRecord, HistoryEvent } from './history';
import { WorkflowWaitError, WorkflowContinueAsNewError } from '../errors';
import { runInWorkflowContext } from './context';
import { getSignalMethods } from '../decorators';

const isPromiseLike = <T = unknown>(value: unknown): value is PromiseLike<T> => {
  return Boolean(value) && typeof (value as { then?: unknown }).then === 'function';
};

export interface ReplayResult {
  workflow: Workflow<unknown[], unknown>;
  result?: unknown;
  error?: unknown;
  status: 'completed' | 'failed' | 'running' | 'waiting' | 'continued';
  newWorkflowId?: string;
  signalCursor?: Record<string, number>;
}

export interface ReplayOptions {
  workflowId: string;
  workflow: Workflow<unknown[], unknown>;
  record: WorkflowRecord;
  history: { events: HistoryEvent[]; cursor: number };
  signals: Array<{ ts: number; name: string; payload: unknown }>;
  isResume: boolean;
  getHistory?: () => Promise<{ events: HistoryEvent[]; cursor: number }>;
  onStep?: (cursor: number, history: { events: HistoryEvent[]; cursor: number }) => Promise<void>;
}

export class ReplayEngine {
  static async run(options: ReplayOptions): Promise<ReplayResult> {
    const { workflowId, workflow, record, isResume, signals, onStep } = options;
    let { history } = options;

    const context = {
      workflowId,
      workflow,
      record,
      isResume,
      clockCursor: 0,
      timerCursor: 0,
      sideEffectCursor: 0,
      activityCursor: 0,
    };

    const signalMethods = getSignalMethods(workflow.constructor);
    const sortedSignals = [...signals].sort((a, b) => a.ts - b.ts);
    const signalCursor: Record<string, number> = { ...(record.signalCursor ?? {}) };
    let signalCursorDirty = false;

    const replaySignals = (
      index: number,
      opts: { initial: boolean; log?: HistoryEvent; nextLog?: HistoryEvent }
    ) => {
      if (signalMethods.length === 0 || signals.length === 0) {
        return;
      }

      const key = index.toString();
      if (!opts.initial && !opts.log) {
        return;
      }

      let lowerBound = signalCursor[key] ?? Number.NEGATIVE_INFINITY;
      if (opts.log) {
        lowerBound = Math.max(lowerBound, opts.log.ts ?? Number.NEGATIVE_INFINITY);
      }

      const upperBound = opts.nextLog ? opts.nextLog.ts : Number.POSITIVE_INFINITY;

      const toReplay = sortedSignals.filter(
        (signal) => signal.ts > lowerBound && signal.ts <= upperBound
      );

      for (const signal of toReplay) {
        if (signalMethods.includes(signal.name)) {
          const argsForSignal = Array.isArray(signal.payload)
            ? signal.payload
            : [signal.payload];
          (workflow as unknown as Record<string, (...args: unknown[]) => void>)[signal.name](...argsForSignal);
        }
      }
      
      if (toReplay.length > 0) {
          signalCursor[key] = toReplay[toReplay.length - 1].ts;
          signalCursorDirty = true;
      }
    };

    let currentIndex = history.cursor ?? 0;
    const effectiveArgs = record.args ?? [];

    const getLogsForIndex = async (
      index: number
    ): Promise<{ log?: HistoryEvent; nextLog?: HistoryEvent }> => {
      if (options.getHistory) {
          history = await options.getHistory();
      }
      return {
        log: history.events[index],
        nextLog: history.events[index + 1],
      };
    };

    const initialLogs = await getLogsForIndex(currentIndex);
    replaySignals(currentIndex, { initial: true, ...initialLogs });

    let generator: AsyncGenerator<unknown, unknown, unknown>;
    let result: IteratorResult<unknown, unknown> | undefined;

    try {
      await runInWorkflowContext(context, async () => {
        generator = workflow.execute(...effectiveArgs);
        result = await generator.next();
      });

      if (typeof result === 'undefined') {
        return {
          workflow,
          error: new Error('Workflow did not yield a result before replay loop.'),
          status: 'failed',
          signalCursor: signalCursorDirty ? signalCursor : undefined
        };
      }

      while (!result.done) {
        let { log, nextLog } = await getLogsForIndex(currentIndex);
        
        while (log && log.type === 'timer-fired') {
          currentIndex++;
          ({ log, nextLog } = await getLogsForIndex(currentIndex));
        }

        replaySignals(currentIndex, { initial: false, log, nextLog });

        if (isPromiseLike(result.value)) {
          try {
            const resolved = await runInWorkflowContext(context, async () => await result!.value);
            
            currentIndex++;
            if (onStep) {
                history.cursor = currentIndex;
                await onStep(currentIndex, history);
            }
            
            result = await runInWorkflowContext(context, async () => await generator.next(resolved));
          } catch (error) {
             if (error instanceof WorkflowWaitError || (error as Error).name === 'WorkflowWaitError') {
               return { 
                   workflow, 
                   status: 'waiting',
                   signalCursor: signalCursorDirty ? signalCursor : undefined
               };
             }
             if (error instanceof WorkflowContinueAsNewError || (error as Error).name === 'WorkflowContinueAsNewError') {
               return { 
                   workflow, 
                   status: 'continued', 
                   newWorkflowId: (error as WorkflowContinueAsNewError).workflowId,
                   signalCursor: signalCursorDirty ? signalCursor : undefined
               };
             }
             
             result = await runInWorkflowContext(context, async () => await generator.throw(error));
          }
        } else {
          currentIndex++;
          if (onStep) {
              history.cursor = currentIndex;
              await onStep(currentIndex, history);
          }
          result = await runInWorkflowContext(context, async () => await generator.next(result!.value));
        }
      }
      
      return { 
          workflow, 
          result: result!.value, 
          status: 'completed',
          signalCursor: signalCursorDirty ? signalCursor : undefined
      };

    } catch (error) {
        if (error instanceof WorkflowWaitError || (error as Error).name === 'WorkflowWaitError') {
            return { 
                workflow, 
                status: 'waiting',
                signalCursor: signalCursorDirty ? signalCursor : undefined
            };
        }
        if (error instanceof WorkflowContinueAsNewError || (error as Error).name === 'WorkflowContinueAsNewError') {
            return { 
                workflow, 
                status: 'continued',
                newWorkflowId: (error as WorkflowContinueAsNewError).workflowId,
                signalCursor: signalCursorDirty ? signalCursor : undefined
            };
        }
        return { 
            workflow, 
            error, 
            status: 'failed',
            signalCursor: signalCursorDirty ? signalCursor : undefined
        };
    }
  }
}
