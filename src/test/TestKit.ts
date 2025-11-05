/**
 * TestKit - Synchronous test driver with time travel
 * 
 * Provides utilities for testing workflows and activities without
 * requiring Redis or BullMQ workers
 */

import { Activity } from '../Activity';

type AnyActivity = Activity<unknown[], unknown>;
type ActivityConstructor<T extends AnyActivity = AnyActivity> = new () => T;
type ActivityArgs<T extends AnyActivity> = Parameters<T['execute']>;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  return typeof value === 'object' && value !== null && 'then' in value &&
    typeof (value as { then: unknown }).then === 'function';
};

/**
 * Activity mock configuration
 */
interface ActivityMock {
  ActivityClass: ActivityConstructor;
  mockValue?: unknown;
  mockFn?: (...args: unknown[]) => unknown;
}

/**
 * Activity dispatch record
 */
interface ActivityDispatch {
  ActivityClass: ActivityConstructor;
  args: unknown[];
  timestamp: number;
}

/**
 * TestKit state
 */
class TestKitState {
  fakeMode = false;
  mocks = new Map<string, ActivityMock>();
  dispatches: ActivityDispatch[] = [];
  virtualClock = new Map<string, number>();
  timeOffset = 0;
}

const state = new TestKitState();

/**
 * TestKit - Testing utilities
 */
export class TestKit {
  /**
   * Enable fake mode - activities execute instantly in-memory
   */
  static fake(): void {
    state.fakeMode = true;
    state.mocks.clear();
    state.dispatches = [];
  }

  /**
   * Disable fake mode - restore normal behavior
   */
  static restore(): void {
    state.fakeMode = false;
    state.mocks.clear();
    state.dispatches = [];
    state.virtualClock.clear();
    state.timeOffset = 0;
  }

  /**
   * Mock an activity with a value or function
   */
  static mock(
    ActivityClass: ActivityConstructor,
  valueOrFn: unknown
  ): void {
    const mock: ActivityMock = {
      ActivityClass,
    };

    if (typeof valueOrFn === 'function') {
      mock.mockFn = valueOrFn as (...args: unknown[]) => unknown;
    } else {
      mock.mockValue = valueOrFn;
    }

    state.mocks.set(ActivityClass.name, mock);
  }

  /**
   * Assert that an activity was dispatched a specific number of times
   */
  static assertDispatched(
    ActivityClass: ActivityConstructor,
    expectedCount?: number
  ): void {
    const dispatches = state.dispatches.filter(
      d => d.ActivityClass === ActivityClass
    );

    if (expectedCount !== undefined) {
      if (dispatches.length !== expectedCount) {
        throw new Error(
          `Expected ${ActivityClass.name} to be dispatched ${expectedCount} times, but was dispatched ${dispatches.length} times`
        );
      }
    } else {
      if (dispatches.length === 0) {
        throw new Error(
          `Expected ${ActivityClass.name} to be dispatched at least once, but was never dispatched`
        );
      }
    }
  }

  /**
   * Assert that an activity was not dispatched
   */
  static assertNotDispatched(ActivityClass: new () => Activity): void {
    const dispatches = state.dispatches.filter(
      d => d.ActivityClass === ActivityClass
    );

    if (dispatches.length > 0) {
      throw new Error(
        `Expected ${ActivityClass.name} not to be dispatched, but was dispatched ${dispatches.length} times`
      );
    }
  }

  /**
   * Get all dispatches for an activity
   */
  static getDispatches(
    ActivityClass: ActivityConstructor
  ): Array<{ args: unknown[]; timestamp: number }> {
    return state.dispatches
      .filter(d => d.ActivityClass === ActivityClass)
      .map(d => ({ args: d.args, timestamp: d.timestamp }));
  }

  /**
   * Enable fake time for a workflow
   */
  static fakeTime(workflowId?: string): void {
    const id = workflowId || '__global__';
    state.virtualClock.set(id, Date.now());
  }

  /**
   * Travel forward in time
   */
  static travel(amount: number, unit: 'ms' | 's' | 'm' | 'h' | 'd' = 's'): void {
    let ms = amount;
    
    switch (unit) {
      case 's':
        ms = amount * 1000;
        break;
      case 'm':
        ms = amount * 60 * 1000;
        break;
      case 'h':
        ms = amount * 60 * 60 * 1000;
        break;
      case 'd':
        ms = amount * 24 * 60 * 60 * 1000;
        break;
    }

    state.timeOffset += ms;

    // Update all virtual clocks
    for (const [id, time] of state.virtualClock.entries()) {
      state.virtualClock.set(id, time + ms);
    }
  }

  /**
   * Get current time (virtual or real)
   */
  static now(workflowId?: string): Date {
    const id = workflowId || '__global__';
    const virtualTime = state.virtualClock.get(id);
    
    if (virtualTime !== undefined) {
      return new Date(virtualTime + state.timeOffset);
    }
    
    return new Date();
  }

  /**
   * Internal: Check if fake mode is enabled
   */
  static _isFakeMode(): boolean {
    return state.fakeMode;
  }

  /**
   * Internal: Get mock for activity
   */
  static _getMock(ActivityClass: new () => Activity): ActivityMock | undefined {
    return state.mocks.get(ActivityClass.name);
  }

  /**
   * Internal: Record activity dispatch
   */
  static _recordDispatch(ActivityClass: ActivityConstructor, args: unknown[]): void {
    state.dispatches.push({
      ActivityClass,
      args,
      timestamp: Date.now(),
    });
  }

  /**
   * Internal: Execute activity with mocking/faking
   */
  static async _executeActivity(
    ActivityClass: ActivityConstructor,
    args: unknown[]
  ): Promise<unknown> {
    // Record dispatch
    TestKit._recordDispatch(ActivityClass, args);

    // Check for mock
    const mock = TestKit._getMock(ActivityClass);
    if (mock) {
      if (mock.mockFn) {
        const result = mock.mockFn(...args);
        return isPromiseLike(result) ? await result : result;
      }
      const { mockValue } = mock;
      return isPromiseLike(mockValue) ? await mockValue : mockValue;
    }

    // In fake mode, execute immediately
    if (state.fakeMode) {
      const activity = new ActivityClass();
      return await activity.execute(...(args as ActivityArgs<AnyActivity>));
    }

    // Normal execution (should go through worker)
    throw new Error('Activity execution in non-fake mode requires workers');
  }
}
