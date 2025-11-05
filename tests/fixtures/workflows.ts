/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable require-yield */
/**
 * Workflow fixtures adapted from the Laravel workflow test suite.
 */

import {
  ActivityStub,
  QueryMethod,
  SignalMethod,
  Workflow,
  WorkflowStub,
} from '../../src';
import {
  TestActivity,
  TestCountActivity,
  TestHeartbeatActivity,
  TestModelActivity,
  TestNonRetryableExceptionActivity,
  TestOtherActivity,
  TestRetriesActivity,
  TestSagaActivity,
  TestSagaUndoActivity,
  TestSingleTryExceptionActivity,
  TestTimeoutActivity,
  TestUndoActivity,
  TestExceptionActivity,
  TestUser,
} from './activities';
import { StateMachine } from './stateMachine';

export class TestWorkflow extends Workflow<[boolean?], string> {
  queue = 'default';

  private canceled = false;

  @SignalMethod()
  cancel(): void {
    this.canceled = true;
  }

  @QueryMethod()
  isCanceled(): boolean {
    return this.canceled;
  }

  async *execute(shouldAssert = false): AsyncGenerator<any, string, any> {
    if (shouldAssert && this.canceled) {
      throw new Error('Workflow should not be canceled before execution begins.');
    }

    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');

    if (shouldAssert && this.canceled) {
      throw new Error('Workflow should remain active before awaiting cancellation.');
    }

    yield WorkflowStub.await(() => this.canceled);

    const result: string = yield ActivityStub.make(TestActivity);

    return `workflow_${result}_${otherResult}`;
  }
}

export class TestAwaitWorkflow extends Workflow<[], string> {
  private canceled = false;

  @SignalMethod()
  cancel(): void {
    this.canceled = true;
  }

  async *execute(): AsyncGenerator<any, string, any> {
    yield WorkflowStub.await(() => this.canceled);
    return 'workflow';
  }
}

export class TestAwaitWithTimeoutWorkflow extends Workflow<[boolean?], string> {
  async *execute(shouldTimeout = false): AsyncGenerator<any, string, any> {
    const completed: boolean = yield WorkflowStub.awaitWithTimeout(0.03, () => !shouldTimeout);
    return completed ? 'workflow' : 'workflow_timed_out';
  }
}

export class TestBadConnectionWorkflow extends Workflow<[boolean?], string> {
  queue = 'default';
  connection = { redisUrl: 'redis://bad-connection' };

  private canceled = false;

  @SignalMethod()
  cancel(): void {
    this.canceled = true;
  }

  @QueryMethod()
  isCanceled(): boolean {
    return this.canceled;
  }

  async *execute(shouldAssert = false): AsyncGenerator<any, string, any> {
    if (shouldAssert && this.canceled) {
      throw new Error('Workflow should not be canceled before execution begins.');
    }

    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');

    if (shouldAssert && this.canceled) {
      throw new Error('Workflow should remain active before awaiting cancellation.');
    }

    yield WorkflowStub.await(() => this.canceled);

    const result: string = yield ActivityStub.make(TestActivity);

    return `workflow_${result}_${otherResult}`;
  }
}

export class TestChildWorkflow extends Workflow<[], string> {
  async *execute(): AsyncGenerator<any, string, any> {
    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');
    return otherResult;
  }
}

export class TestChildExceptionWorkflow extends Workflow<[boolean?], string> {
  queue = 'default';

  async *execute(shouldThrow = false): AsyncGenerator<any, string, any> {
    if (shouldThrow) {
      throw new Error('failed');
    }

    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');
    return otherResult;
  }
}

export class TestChildTimerWorkflow extends Workflow<[number?], string> {
  queue = 'default';

  async *execute(seconds = 0.01): AsyncGenerator<any, string, any> {
    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');
    yield WorkflowStub.timer(seconds);
    return otherResult;
  }
}

export class TestParentWorkflow extends Workflow<[], string> {
  queue = 'default';

  @SignalMethod()
  ping(): void {
    // no-op
  }

  async *execute(): AsyncGenerator<any, string, any> {
    const otherResult: string = yield WorkflowStub.child(TestChildWorkflow);
    const result: string = yield ActivityStub.make(TestActivity);
    return `workflow_${result}_${otherResult}`;
  }
}

export class TestParentExceptionWorkflow extends Workflow<[boolean?], string> {
  queue = 'default';

  async *execute(shouldThrow = false): AsyncGenerator<any, string, any> {
  const otherResult = (yield WorkflowStub.child(TestChildExceptionWorkflow, shouldThrow)) as string;
  const result = (yield ActivityStub.make(TestActivity)) as string;
    return `workflow_${result}_${otherResult}`;
  }
}

export class TestParentAsyncWorkflow extends Workflow<[], string> {
  queue = 'default';

  async *execute(): AsyncGenerator<any, string, any> {
    const results: [string, string] = yield ActivityStub.async(function* () {
      const otherResult = (yield WorkflowStub.child(TestChildWorkflow)) as string;
      const result = (yield ActivityStub.make(TestActivity)) as string;
      return [otherResult, result];
    });

    const [otherResult, result] = results;
    return `workflow_${result}_${otherResult}`;
  }
}

export class TestAsyncWorkflow extends Workflow<[], string> {
  async *execute(): AsyncGenerator<any, string, any> {
    const results: [string, string] = yield ActivityStub.async(function* () {
      const otherResult = (yield ActivityStub.make(TestOtherActivity, 'other')) as string;
      const result = (yield ActivityStub.make(TestActivity)) as string;
      return [otherResult, result];
    });

    const [otherResult, result] = results;
    return `workflow_${result}_${otherResult}`;
  }
}

export class TestConcurrentWorkflow extends Workflow<[], string> {
  async *execute(): AsyncGenerator<any, string, any> {
    const otherPromise = ActivityStub.make(TestOtherActivity, 'other');
    const resultPromise = ActivityStub.make(TestActivity);

    const [otherResult, result]: [string, string] = yield ActivityStub.all([
      otherPromise,
      resultPromise,
    ]);

    return `workflow_${result}_${otherResult}`;
  }
}

export class TestContinueAsNewWorkflow extends Workflow<[number?, number?], string> {
  async *execute(initialCount = 0, totalCount = 3): AsyncGenerator<any, string, any> {
    const activityResult: number = yield ActivityStub.make(TestCountActivity, initialCount);

    if (initialCount >= totalCount) {
      return `workflow_${activityResult}`;
    }

    return (yield WorkflowStub.continueAsNew(initialCount + 1, totalCount)) as never;
  }
}

export class TestChildContinueAsNewWorkflow extends Workflow<[number?, number?], string> {
  async *execute(initialCount = 0, totalCount = 3): AsyncGenerator<any, string, any> {
    const activityResult: number = yield ActivityStub.make(TestCountActivity, initialCount);

    if (initialCount >= totalCount) {
      return `child_workflow_${activityResult}`;
    }

    return (yield WorkflowStub.continueAsNew(initialCount + 1, totalCount)) as never;
  }
}

export class TestFailingWorkflow extends Workflow<[boolean?], string> {
  async *execute(shouldFail = false): AsyncGenerator<any, string, any> {
    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');

    if (shouldFail) {
      throw new Error('failed');
    }

    const result: string = yield ActivityStub.make(TestActivity);

    return `workflow_${result}_${otherResult}`;
  }
}

export class TestSimpleWorkflow extends Workflow<[], string> {
  queue = 'default';

  async *execute(): AsyncGenerator<any, string, any> {
    const result: string = yield ActivityStub.make(TestActivity);
    return `workflow_${result}`;
  }
}

export class TestTimerWorkflow extends Workflow<[number?], string> {
  async *execute(seconds = 0.01): AsyncGenerator<any, string, any> {
    yield WorkflowStub.timer(seconds);
    return 'workflow';
  }
}

export class TestTimeTravelWorkflow extends Workflow<[], string> {
  private canceled = false;

  @SignalMethod()
  cancel(): void {
    this.canceled = true;
  }

  @QueryMethod()
  isCanceled(): boolean {
    return this.canceled;
  }

  async *execute(): AsyncGenerator<any, string, any> {
    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');

    yield WorkflowStub.await(() => this.canceled);

    const result: string = yield ActivityStub.make(TestActivity);

    yield WorkflowStub.timer(0.01);

    return `workflow_${result}_${otherResult}`;
  }
}

export class TestExceptionWorkflow extends Workflow<[], string> {
  async *execute(): AsyncGenerator<any, string, any> {
    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');
    const result: string = yield ActivityStub.make(TestExceptionActivity);
    return `workflow_${result}_${otherResult}`;
  }
}

export class TestHeartbeatWorkflow extends Workflow<[], string> {
  async *execute(): AsyncGenerator<any, string, any> {
    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');
    const result: string = yield ActivityStub.make(TestHeartbeatActivity);
    return `workflow_${result}_${otherResult}`;
  }
}

export class TestTimeoutWorkflow extends Workflow<[], void> {
  queue = 'default';

  async *execute(): AsyncGenerator<any, void, any> {
    yield ActivityStub.make(TestTimeoutActivity);
  }
}

export class TestParentContinueAsNewChildWorkflow extends Workflow<[], string> {
  async *execute(): AsyncGenerator<any, string, any> {
    const childResult: string = yield WorkflowStub.child(TestChildContinueAsNewWorkflow);
    return `parent_${childResult}`;
  }
}

export class TestParentTimerWorkflow extends Workflow<[number?], string> {
  queue = 'default';

  async *execute(seconds = 0.01): AsyncGenerator<any, string, any> {
    const otherResult: string = yield WorkflowStub.child(TestChildTimerWorkflow, seconds);
    const result: string = yield ActivityStub.make(TestActivity);
    return `workflow_${result}_${otherResult}`;
  }
}

export class TestRetriesWorkflow extends Workflow<[], void> {
  queue = 'default';

  async *execute(): AsyncGenerator<any, void, any> {
    yield ActivityStub.make(TestRetriesActivity);
  }
}

export class TestNonRetryableExceptionWorkflow extends Workflow<[], string> {
  async *execute(): AsyncGenerator<any, string, any> {
    yield ActivityStub.make(TestNonRetryableExceptionActivity);
    yield ActivityStub.make(TestActivity);
    return 'Workflow completes';
  }
}

export class TestSagaWorkflow extends Workflow<[boolean?], string> {
  async *execute(shouldThrow = false): AsyncGenerator<any, string, any> {
    try {
      yield ActivityStub.make(TestActivity);
      this.addCompensation(async () => {
        await ActivityStub.make(TestUndoActivity);
      });

      yield ActivityStub.make(TestSagaActivity);
      this.addCompensation(async () => {
        await ActivityStub.make(TestSagaUndoActivity);
      });
    } catch (error) {
      yield* this.compensate();
      if (shouldThrow) {
        throw error;
      }
    }

    return 'saga_workflow';
  }
}

export class TestSideEffectWorkflow extends Workflow<[], string> {
  queue = 'default';

  async *execute(): AsyncGenerator<any, string, any> {
    const sideEffect: number = yield WorkflowStub.sideEffect(() => Math.floor(Math.random() * 1_000_000));

    const badSideEffect = Math.floor(Math.random() * 1_000_000);

    const result: string = yield ActivityStub.make(TestActivity);

    const otherResult1: string = yield ActivityStub.make(TestOtherActivity, sideEffect.toString());
    const otherResult2: string = yield ActivityStub.make(TestOtherActivity, badSideEffect.toString());

    if (sideEffect.toString() !== otherResult1) {
      throw new Error('Side effect mismatch for WorkflowStub.sideEffect()');
    }

    if (badSideEffect.toString() === otherResult2) {
      throw new Error('Unexpected side effect match without WorkflowStub.sideEffect().');
    }

    return 'workflow';
  }
}

export class TestSignalExceptionWorkflow extends Workflow<[Record<string, unknown>?], boolean> {
  protected shouldRetry = false;

  @SignalMethod()
  shouldRetrySignal(): void {
    this.shouldRetry = true;
  }

  async *execute(): AsyncGenerator<any, boolean, any> {
    let shouldThrow = true;

    while (true) {
      try {
        yield ActivityStub.make(TestActivity);
        yield ActivityStub.make(TestSingleTryExceptionActivity, shouldThrow);
        return true;
      } catch {
        yield WorkflowStub.await(() => this.shouldRetry);
        this.shouldRetry = false;
        shouldThrow = false;
      }
    }
  }
}

export class TestSignalExceptionWorkflowLeader extends Workflow<[Record<string, unknown>?], boolean> {
  protected shouldRetry = false;

  @SignalMethod()
  shouldRetrySignal(): void {
    this.shouldRetry = true;
  }

  async *execute(): AsyncGenerator<any, boolean, any> {
    let shouldThrow = true;

    while (true) {
      try {
        yield ActivityStub.make(TestSingleTryExceptionActivity, shouldThrow);
        return true;
      } catch {
        yield WorkflowStub.await(() => this.shouldRetry);
        this.shouldRetry = false;
        shouldThrow = false;
      }
    }
  }
}

export interface StoredWorkflowRecord {
  id: string;
}

export class TestStateMachineWorkflow extends Workflow<[], string> {
  queue = 'default';
  connection = { redisUrl: 'redis://default' };

  private stateMachine: StateMachine;
  private submitted = false;

  constructor(private storedWorkflow: StoredWorkflowRecord = { id: 'demo' }) {
    super();

    this.stateMachine = new StateMachine();
    this.stateMachine.addState('created');
    this.stateMachine.addState('submitted');
    this.stateMachine.addState('approved');
    this.stateMachine.addState('denied');

    this.stateMachine.addTransition('submit', 'created', 'submitted');
    this.stateMachine.addTransition('approve', 'submitted', 'approved');
    this.stateMachine.addTransition('deny', 'submitted', 'denied');

    this.stateMachine.initialize();
  }

  @SignalMethod()
  submit(): void {
    this.stateMachine.apply('submit');
    this.submitted = true;
  }

  @SignalMethod()
  approve(): void {
    this.stateMachine.apply('approve');
  }

  @SignalMethod()
  deny(): void {
    this.stateMachine.apply('deny');
  }

  isSubmitted(): boolean {
    return this.submitted;
  }

  isApproved(): boolean {
    return this.stateMachine.getCurrentState() === 'approved';
  }

  isDenied(): boolean {
    return this.stateMachine.getCurrentState() === 'denied';
  }

  async *execute(): AsyncGenerator<any, string, any> {
    yield WorkflowStub.await(() => this.isSubmitted());
    yield WorkflowStub.await(() => this.isApproved() || this.isDenied());
    return this.stateMachine.getCurrentState() ?? 'unknown';
  }
}

export class TestThrowOnReturnWorkflow extends Workflow<[], { valid(): boolean }> {
  async *execute(): AsyncGenerator<any, { valid(): boolean }, any> {
    return {
      valid() {
        return false;
      },
    };
  }
}

export class TestYieldNonPromiseWorkflow extends Workflow<[], void> {
  async *execute(): AsyncGenerator<any, void, any> {
    yield 'not-a-promise';
  }
}

export class TestModelWorkflow extends Workflow<[TestUser?], number> {
  async *execute(user: TestUser = { id: 123 }): AsyncGenerator<any, number, any> {
    const result: number = yield ActivityStub.make(TestModelActivity, user);
    return result;
  }
}

export class TestModelNotFoundWorkflow extends Workflow<[StoredWorkflowRecord], void> {
  queue = 'default';
  connection = { redisUrl: 'redis://default' };

  async *execute(_log: StoredWorkflowRecord): AsyncGenerator<any, void, any> {
    // intentionally empty
  }
}

export class TestWebhookWorkflow extends Workflow<[boolean?], string> {
  queue = 'default';
  connection = { redisUrl: 'redis://default' };

  private canceled = false;

  @SignalMethod()
  cancel(): void {
    this.canceled = true;
  }

  @QueryMethod()
  isCanceled(): boolean {
    return this.canceled;
  }

  async *execute(shouldAssert = false): AsyncGenerator<any, string, any> {
    if (shouldAssert && this.canceled) {
      throw new Error('Workflow should not be canceled before execution begins.');
    }

    const otherResult: string = yield ActivityStub.make(TestOtherActivity, 'other');

    if (shouldAssert && this.canceled) {
      throw new Error('Workflow should remain active before awaiting cancellation.');
    }

    yield WorkflowStub.await(() => this.canceled);

    const result: string = yield ActivityStub.make(TestActivity);

    return `workflow_${result}_${otherResult}`;
  }
}
