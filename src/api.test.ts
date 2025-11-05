/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable require-yield */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/**
 * Tests for the unified Durabull API
 */

import { Workflow, Activity, WorkflowStub, ActivityStub, SignalMethod, QueryMethod } from './index';
import { TestKit } from './test/TestKit';

describe('Durabull API', () => {
  describe('Activity', () => {
    class TestActivity extends Activity<[number], number> {
      tries = 1;
      timeout = 5;

      async execute(value: number): Promise<number> {
        return value * 2;
      }
    }

    it('executes activity successfully', async () => {
      const activity = new TestActivity();
      activity._setContext({
        workflowId: 'wf-1',
        activityId: 'act-1',
        attempt: 0,
        heartbeat: () => undefined,
      });

      const result = await activity._executeWithRetry(5);
      expect(result).toBe(10);
    });

    it('retries on failure', async () => {
      let attempts = 0;

      class RetryActivity extends Activity<[], string> {
        tries = 3;

        backoff() {
          return [0.01, 0.01];
        }

        async execute(): Promise<string> {
          attempts++;
          if (attempts < 3) {
            throw new Error('Transient error');
          }
          return 'success';
        }
      }

      const activity = new RetryActivity();
      activity._setContext({
        workflowId: 'wf-2',
        activityId: 'act-2',
        attempt: 0,
        heartbeat: () => undefined,
      });

      const result = await activity._executeWithRetry();
      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('supports custom backoff schedules', async () => {
      class CustomBackoffActivity extends Activity<[], string> {
        tries = 2;

        backoff() {
          return [0.01, 0.01];
        }

        async execute(): Promise<string> {
          throw new Error('Always fails');
        }
      }

      const activity = new CustomBackoffActivity();
      activity._setContext({
        workflowId: 'wf-3',
        activityId: 'act-3',
        attempt: 0,
        heartbeat: () => undefined,
      });

      await expect(activity._executeWithRetry()).rejects.toThrow('Always fails');
    });
  });

  describe('Workflow', () => {
    class SimpleWorkflow extends Workflow<[string], string> {
      async *execute(input: string): AsyncGenerator<any, string, any> {
        return `Hello, ${input}!`;
      }
    }

    it('executes a simple workflow', async () => {
      const wf = await WorkflowStub.make(SimpleWorkflow);
      await wf.start('World');
      const output = await wf.output();
      expect(output).toBe('Hello, World!');
    });

    it('executes workflow with activity', async () => {
      class DoubleActivity extends Activity<[number], number> {
        async execute(n: number): Promise<number> {
          return n * 2;
        }
      }

      class ActivityWorkflow extends Workflow<[number], number> {
        async *execute(input: number): AsyncGenerator<any, number, any> {
          const result = yield ActivityStub.make(DoubleActivity, input);
          return result;
        }
      }

      const wf = await WorkflowStub.make(ActivityWorkflow);
      await wf.start(21);
      const output = await wf.output();
      expect(output).toBe(42);
    });

    it('propagates workflow errors', async () => {
      class ErrorWorkflow extends Workflow<[], never> {
        async *execute(): AsyncGenerator<any, never, any> {
          throw new Error('Workflow error');
        }
      }

      const wf = await WorkflowStub.make(ErrorWorkflow);
      await expect(wf.start()).rejects.toThrow('Workflow error');
      expect(await wf.status()).toBe('failed');
    });

    it('supports continue-as-new semantics with fresh workflow instances', async () => {
      class ContinueWorkflow extends Workflow<[number, number?], number> {
        private invocationCount = 0;

        async *execute(step = 0, max = 2): AsyncGenerator<any, number, any> {
          this.invocationCount += 1;

          if (step >= max) {
            return this.invocationCount;
          }

          return (yield WorkflowStub.continueAsNew(step + 1, max)) as never;
        }
      }

      const wf = await WorkflowStub.make(ContinueWorkflow);
      await wf.start(0, 3);

      await expect(wf.output()).resolves.toBe(1);
      await expect(wf.status()).resolves.toBe('completed');
    });

    it('provides a Date instance via WorkflowStub.now()', async () => {
      class NowWorkflow extends Workflow<[], Date> {
        async *execute(): AsyncGenerator<any, Date, any> {
          const current = (yield WorkflowStub.now()) as Date;
          return current;
        }
      }

      const before = Date.now();
      const wf = await WorkflowStub.make(NowWorkflow);
      await wf.start();
      const result = await wf.output<Date>();
      const after = Date.now();

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.getTime()).toBeLessThanOrEqual(after);
    });

    it('honors TestKit fake time when using WorkflowStub.now()', async () => {
      class FakeTimeWorkflow extends Workflow<[], number> {
        async *execute(): AsyncGenerator<any, number, any> {
          const current = (yield WorkflowStub.now()) as Date;
          return current.getTime();
        }
      }

      TestKit.fake();
      TestKit.fakeTime();
      TestKit.travel(42, 's');
      const expected = TestKit.now().getTime();

      try {
        const wf = await WorkflowStub.make(FakeTimeWorkflow);
        await wf.start();
        const timestamp = await wf.output<number>();

        expect(timestamp).toBe(expected);
      } finally {
        TestKit.restore();
      }
    });
  });

  describe('ActivityStub', () => {
    it('executes activity via make()', async () => {
      class UpperActivity extends Activity<[string], string> {
        async execute(input: string): Promise<string> {
          return input.toUpperCase();
        }
      }

      const promise = ActivityStub.make(UpperActivity, 'hello');
      const result = await promise;
      expect(result).toBe('HELLO');
    });

    it('executes activities in parallel with all()', async () => {
      class SlowActivity extends Activity<[number], number> {
        async execute(ms: number): Promise<number> {
          await new Promise(resolve => setTimeout(resolve, ms));
          return ms;
        }
      }

      const startTime = Date.now();
      const results = await ActivityStub.all([
        ActivityStub.make(SlowActivity, 20),
        ActivityStub.make(SlowActivity, 30),
        ActivityStub.make(SlowActivity, 40),
      ]);
      const elapsed = Date.now() - startTime;

      expect(results).toEqual([20, 30, 40]);
  expect(elapsed).toBeLessThan(200);
  expect(elapsed).toBeGreaterThanOrEqual(15);
    });

    it('supports async generator helper', async () => {
      class Activity1 extends Activity<[number], number> {
        async execute(n: number): Promise<number> {
          return n + 1;
        }
      }

      class Activity2 extends Activity<[number], number> {
        async execute(n: number): Promise<number> {
          return n * 2;
        }
      }

      const result = await ActivityStub.async(function* () {
  const a = (yield ActivityStub.make(Activity1, 5)) as number;
  const b = (yield ActivityStub.make(Activity2, a)) as number;
        return b;
      });

      expect(result).toBe(12);
    });
  });

  describe('Decorators', () => {
    class DecoratedWorkflow extends Workflow<[], string> {
      private value = 0;

  // @ts-ignore decorators in test context
  @SignalMethod()
      increment() {
        this.value++;
      }

  // @ts-ignore decorators in test context
  @QueryMethod()
      getValue(): number {
        return this.value;
      }

      async *execute(): AsyncGenerator<any, string, any> {
        return 'done';
      }
    }

    it('detects signal methods', () => {
      const { getSignalMethods } = require('./decorators');
      const signals = getSignalMethods(DecoratedWorkflow);
      expect(signals).toContain('increment');
    });

    it('detects query methods', () => {
      const { getQueryMethods } = require('./decorators');
      const queries = getQueryMethods(DecoratedWorkflow);
      expect(queries).toContain('getValue');
    });

    it('executes query methods directly', async () => {
      const wf = await WorkflowStub.make(DecoratedWorkflow) as any;
      expect(wf.getValue()).toBe(0);
      
      wf._getWorkflow().increment();
      expect(wf.getValue()).toBe(1);
    });
  });

  describe('Compensation support', () => {
    it('runs compensations in reverse order', async () => {
      const order: string[] = [];

      class CompensationWorkflow extends Workflow<[], string> {
        async *execute(): AsyncGenerator<any, string, any> {
          try {
            order.push('action1');
            this.addCompensation(async () => {
              order.push('undo1');
            });

            order.push('action2');
            this.addCompensation(async () => {
              order.push('undo2');
            });

            throw new Error('Something went wrong');
          } catch (error) {
            yield* this.compensate();
            throw error;
          }
        }
      }

      const wf = await WorkflowStub.make(CompensationWorkflow);
      
      try {
        await wf.start();
      } catch (error) {
        // Expected failure
      }

      expect(order).toEqual(['action1', 'action2', 'undo2', 'undo1']);
    });
  });
});
