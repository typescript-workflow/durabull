/**
 * ActivityStub - interface for executing activities from workflows
 */

import { Activity } from './Activity';
import { getQueues } from './queues';
import { WorkflowStub, WorkflowWaitError } from './WorkflowStub';

type AnyActivity = Activity<unknown[], unknown>;
type ActivityConstructor<T extends AnyActivity = AnyActivity> = new () => T;
type ActivityArgs<T extends AnyActivity> = Parameters<T['execute']>;
type ActivityResult<T extends AnyActivity> = Awaited<ReturnType<T['execute']>>;

/**
 * Options for activity execution with per-invocation overrides
 */
export interface ActivityOptions {
  tries?: number;
  timeout?: number;
  backoff?: number[];
  activityId?: string;
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  return typeof value === 'object' && value !== null && 'then' in value &&
    typeof (value as { then: unknown }).then === 'function';
};

/**
 * Promise-like wrapper around activity execution
 */
export class ActivityPromise<T = unknown> implements PromiseLike<T> {
  constructor(private promise: Promise<T>) {}

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }
}

export class ActivityStub {
  /**
   * Execute an activity - queues to BullMQ in durable mode, executes inline in test mode
   */
  static make<T extends AnyActivity>(
    activityClassOrName: ActivityConstructor<T> | string,
    ...argsWithOptions: [...args: ActivityArgs<T>, options?: ActivityOptions] | ActivityArgs<T>
  ): ActivityPromise<ActivityResult<T>> {
    // Parse args and options
    const lastArg = argsWithOptions[argsWithOptions.length - 1];
    let options: ActivityOptions | undefined;
    let args: ActivityArgs<T>;
    
    // Check for explicit options wrapper
    const isWrappedOptions = lastArg &&
      typeof lastArg === 'object' &&
      !Array.isArray(lastArg) &&
      Object.prototype.toString.call(lastArg) === '[object Object]' &&
      Object.prototype.hasOwnProperty.call(lastArg, '__options');

    if (isWrappedOptions) {
      options = (lastArg as { __options: ActivityOptions }).__options;
      args = argsWithOptions.slice(0, -1) as ActivityArgs<T>;
    } else {
      args = argsWithOptions as ActivityArgs<T>;
    }

    let activityName: string;
    let defaultTries: number | undefined;
    let defaultBackoff: number[] | undefined;

    if (typeof activityClassOrName === 'string') {
      activityName = activityClassOrName;
    } else {
      activityName = activityClassOrName.name;
      try {
        const instance = new activityClassOrName();
        defaultTries = instance.tries;
        // We can't easily get the backoff method result without calling it, 
        // but backoff() is a method returning number[].
        if (instance.backoff) {
            defaultBackoff = instance.backoff();
        }
      } catch (e) {
        // Ignore instantiation errors
      }
    }

    // Generate activity ID synchronously to ensure deterministic ordering
    // This must happen before the async function executes to capture the correct activityCursor
    const activityId = options?.activityId || WorkflowStub._generateActivityId();
    
    // CRITICAL FIX: Ensure immutable capture of activity metadata before async execution
    // These const declarations create a proper closure that cannot be modified by subsequent calls
    const finalActivityName = activityName;
    const finalArgs = Array.isArray(args) ? [...args] : args;
    const finalDefaultTries = defaultTries;
    const finalDefaultBackoff = defaultBackoff;

    // Queue activity and return promise that will be resolved by workflow worker via history replay
    const promise = (async () => {
      const workflowContext = WorkflowStub._getContext();
      if (!workflowContext) {
        throw new Error('ActivityStub must be called within a workflow context');
      }

      const queues = getQueues();
      const workflowId = workflowContext.workflowId;
      
      // CRITICAL FIX: Use history from context instead of reading from storage
      // This ensures we're checking against the same history that ReplayEngine is using
      const history = workflowContext.history;

      // Check if this activity already completed (replay)
      if (history) {
        const existingEvent = history.events.find(
          (e) => e.type === 'activity' && e.id === activityId
        );
        
        if (existingEvent && existingEvent.type === 'activity') {
          // Activity already completed during previous execution - return cached result
          if (existingEvent.error) {
            throw new Error(existingEvent.error.message || 'Activity failed');
          }
          return existingEvent.result as ActivityResult<T>;
        }
      }

      // Activity not in history - need to queue it
      // Build retry options from activity metadata and per-invocation overrides
      const retryOptions: { tries?: number; timeout?: number; backoff?: number[] } = {};
      
      const tries = options?.tries ?? finalDefaultTries;
      if (tries !== undefined) retryOptions.tries = tries;
      
      if (options?.timeout !== undefined) retryOptions.timeout = options.timeout;
      
      const backoff = options?.backoff ?? finalDefaultBackoff;
      if (backoff) retryOptions.backoff = backoff;

      // Map to BullMQ options
      // tries: 0 means retry forever (MAX_INT)
      const attempts = (tries === 0) ? Number.MAX_SAFE_INTEGER : (tries || 1);
      
      // Queue the activity job (only on first execution, not replay)
      // Use activityId as BullMQ jobId to prevent duplicate jobs
      await queues.activity.add('execute', {
        workflowId,
        activityClass: finalActivityName,
        activityId,
        args: finalArgs,
        retryOptions: Object.keys(retryOptions).length > 0 ? retryOptions : undefined,
      }, {
        jobId: `${workflowId}:${activityId}`,  // Ensures uniqueness per workflow
        attempts,
        backoff: {
            type: 'custom', // We use the custom strategy defined in worker
        }
      });

      // Throw WorkflowWaitError to suspend execution - worker will resume when activity completes
      throw new WorkflowWaitError(`Waiting for activity ${activityId}`);
    })();

    return new ActivityPromise<ActivityResult<T>>(promise as Promise<ActivityResult<T>>);
  }

  /**
   * Execute multiple activities in parallel
   */
  static all<T extends readonly ActivityPromise<unknown>[]>(
    promises: T
  ): ActivityPromise<{ [K in keyof T]: T[K] extends ActivityPromise<infer U> ? U : never }> {
    const allPromise = Promise.all(promises.map(p => p as PromiseLike<unknown>)) as Promise<
      { [K in keyof T]: T[K] extends ActivityPromise<infer U> ? U : never }
    >;
    return new ActivityPromise<{ [K in keyof T]: T[K] extends ActivityPromise<infer U> ? U : never }>(
      allPromise
    );
  }

  /**
   * Execute an async generator helper (mini sub-workflow)
   */
  static async<T>(
    genFn: () => AsyncGenerator<unknown, T, unknown> | Generator<unknown, T, unknown>
  ): ActivityPromise<T> {
    const promise = (async () => {
      const gen = genFn();
      let result = await gen.next();

      while (!result.done) {
        if (isPromiseLike(result.value)) {
          const resolved = await result.value;
          result = await gen.next(resolved);
          continue;
        }

        result = await gen.next(result.value);
      }

      return result.value;
    })();

    return new ActivityPromise<T>(promise);
  }
}
