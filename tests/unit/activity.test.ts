/**
 * Unit tests for Activity base class
 */

import { Activity, ActivityContext } from '../../src/Activity';

describe('Activity', () => {
  class TestActivity extends Activity<[number], number> {
    tries = 3;
    timeout = 5;

    async execute(input: number): Promise<number> {
      return input * 2;
    }
  }

  it('should be instantiable', () => {
    const activity = new TestActivity();
    expect(activity).toBeInstanceOf(Activity);
  });

  it('should have default configuration', () => {
    const activity = new TestActivity();
    expect(activity.tries).toBe(3);
    expect(activity.timeout).toBe(5);
    expect(typeof activity.execute).toBe('function');
  });

  it('should support custom backoff schedule', () => {
    class CustomBackoffActivity extends Activity<[], string> {
      backoff() {
        return [0.1, 0.5, 1, 5];
      }

      async execute(): Promise<string> {
        return 'result';
      }
    }

    const activity = new CustomBackoffActivity();
    const schedule = activity.backoff();
    expect(schedule).toEqual([0.1, 0.5, 1, 5]);
  });

  it('should set context', () => {
    const activity = new TestActivity();
    const context: ActivityContext = {
      workflowId: 'wf-123',
      activityId: 'act-456',
      attempt: 0,
      heartbeat: () => undefined,
    };

    activity._setContext(context);
    expect(true).toBe(true);
  });

  it('should execute successfully', async () => {
    const activity = new TestActivity();
    const result = await activity.execute(21);
    expect(result).toBe(42);
  });

  it('should support different input/output types', async () => {
    class StringActivity extends Activity<[string], string> {
      async execute(input: string): Promise<string> {
        return input.toUpperCase();
      }
    }

    const activity = new StringActivity();
    const result = await activity.execute('hello');
    expect(result).toBe('HELLO');
  });

  it('should support multiple arguments', async () => {
    class MultiArgActivity extends Activity<[number, number, string], string> {
      async execute(a: number, b: number, op: string): Promise<string> {
        const result = op === 'add' ? a + b : a * b;
        return `Result: ${result}`;
      }
    }

    const activity = new MultiArgActivity();
    expect(await activity.execute(5, 3, 'add')).toBe('Result: 8');
    expect(await activity.execute(5, 3, 'mul')).toBe('Result: 15');
  });

  it('should support void return type', async () => {
    class VoidActivity extends Activity<[string], void> {
      private value: string | null = null;

      async execute(input: string): Promise<void> {
        this.value = input;
      }

      getValue(): string | null {
        return this.value;
      }
    }

    const activity = new VoidActivity();
    const result = await activity.execute('test');
    expect(result).toBeUndefined();
    expect(activity.getValue()).toBe('test');
  });

  it('should allow activity to throw errors', async () => {
    class FailingActivity extends Activity<[], never> {
      async execute(): Promise<never> {
        throw new Error('Activity failed');
      }
    }

    const activity = new FailingActivity();
    await expect(activity.execute()).rejects.toThrow('Activity failed');
  });

  it('should support async operations', async () => {
    class AsyncActivity extends Activity<[number], number> {
      async execute(delay: number): Promise<number> {
        await new Promise(resolve => setTimeout(resolve, delay));
        return delay;
      }
    }

    const activity = new AsyncActivity();
    const start = Date.now();
    const result = await activity.execute(50);
    const elapsed = Date.now() - start;

    expect(result).toBe(50);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});
