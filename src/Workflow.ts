import { getLogger } from './runtime/logger';

export interface WorkflowConfig {
  queue?: string;
  connection?: { redisUrl?: string };
}

type AsyncGeneratorLike = AsyncGenerator<unknown, unknown, unknown>;

const isAsyncGenerator = (value: unknown): value is AsyncGeneratorLike => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { next?: unknown; [Symbol.asyncIterator]?: unknown };
  return typeof candidate.next === 'function' && typeof candidate[Symbol.asyncIterator] === 'function';
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  return typeof value === 'object' && value !== null && 'then' in value &&
    typeof (value as { then: unknown }).then === 'function';
};

export abstract class Workflow<TArgs extends unknown[] = unknown[], TResult = unknown> {
  queue?: string;
  connection?: { redisUrl?: string };

  private compensations: Array<() => AsyncGeneratorLike | Promise<unknown> | unknown> = [];
  private parallelCompensation = false;
  private continueWithError = false;

  abstract execute(...args: TArgs): AsyncGenerator<unknown, TResult, unknown>;

  protected addCompensation(fn: () => AsyncGeneratorLike | Promise<unknown> | unknown) {
    this.compensations.push(fn);
  }

  protected async *compensate(): AsyncGenerator<unknown, void, unknown> {
    const toRun = [...this.compensations].reverse();

    if (this.parallelCompensation) {
      const promises = toRun.map(async fn => {
        try {
          const result = fn();
          if (isAsyncGenerator(result)) {
            for await (const _ of result) {
              // consume generator stream to allow side effects
            }
            return;
          }

          if (isPromiseLike(result)) {
            await result;
            return;
          } else {
            void result;
          }
        } catch (error) {
          if (!this.continueWithError) {
            throw error;
          }
          const logger = getLogger();
          logger.error('Compensation error (ignored)', error);
        }
      });
      await Promise.all(promises);
      yield;
    } else {
      for (const fn of toRun) {
        try {
          const result = fn();
          if (isAsyncGenerator(result)) {
            for await (const value of result) {
              yield value;
            }
            continue;
          }

          if (isPromiseLike(result)) {
            yield await result;
            continue;
          }

          yield result;
        } catch (error) {
          if (!this.continueWithError) {
            throw error;
          }
          const logger = getLogger();
          logger.error('Compensation error (ignored)', error);
        }
      }
    }
  }

  protected setParallelCompensation(parallel: boolean) {
    this.parallelCompensation = parallel;
  }

  protected setContinueWithError(continueOnError: boolean) {
    this.continueWithError = continueOnError;
  }
}
