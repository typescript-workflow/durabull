/**
 * ActivityStub - interface for executing activities from workflows
 */

import { Activity, ActivityContext } from './Activity';

type AnyActivity = Activity<unknown[], unknown>;
type ActivityConstructor<T extends AnyActivity = AnyActivity> = new () => T;
type ActivityArgs<T extends AnyActivity> = Parameters<T['execute']>;
type ActivityResult<T extends AnyActivity> = Awaited<ReturnType<T['execute']>>;

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
   * Execute an activity immediately (test-mode friendly)
   */
  static make<T extends AnyActivity>(
    ActivityClass: ActivityConstructor<T>,
    ...args: ActivityArgs<T>
  ): ActivityPromise<ActivityResult<T>> {
    const activity = new ActivityClass();

    const context: ActivityContext = {
      workflowId: 'wf-' + Math.random().toString(36).substring(7),
      activityId: 'act-' + Math.random().toString(36).substring(7),
      attempt: 0,
      heartbeat: () => undefined,
    };

    activity._setContext(context);

    const promise = activity._executeWithRetry(...args) as Promise<ActivityResult<T>>;
    return new ActivityPromise<ActivityResult<T>>(promise);
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
