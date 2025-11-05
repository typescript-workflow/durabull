import {
  TestAsyncWorkflow,
  TestConcurrentWorkflow,
  TestContinueAsNewWorkflow,
  TestChildContinueAsNewWorkflow,
  TestFailingWorkflow,
  TestSimpleWorkflow,
  TestTimerWorkflow,
  TestExceptionWorkflow,
  TestHeartbeatWorkflow,
  TestTimeoutWorkflow,
  TestRetriesWorkflow,
  TestNonRetryableExceptionWorkflow,
  TestSagaWorkflow,
  TestSideEffectWorkflow,
} from '../fixtures/workflows';
import { WorkflowStub } from '../../src';

jest.setTimeout(30000);

describe('Workflow execution behaviors', () => {
  it('runs async and concurrent workflows', async () => {
    const asyncWorkflow = await WorkflowStub.make(TestAsyncWorkflow);
    await asyncWorkflow.start();
    await expect(asyncWorkflow.output<string>()).resolves.toBe('workflow_activity_other');

    const concurrent = await WorkflowStub.make(TestConcurrentWorkflow);
    await concurrent.start();
    await expect(concurrent.output<string>()).resolves.toBe('workflow_activity_other');
  });

  it('repeats until continue-as-new would occur', async () => {
    const workflow = await WorkflowStub.make(TestContinueAsNewWorkflow);
    await workflow.start(0, 2);
    await expect(workflow.output<string>()).resolves.toBe('workflow_2');

    const child = await WorkflowStub.make(TestChildContinueAsNewWorkflow);
    await child.start(0, 2);
    await expect(child.output<string>()).resolves.toBe('child_workflow_2');
  });

  it('handles failing workflow branches', async () => {
    const success = await WorkflowStub.make(TestFailingWorkflow);
    await success.start(false);
    await expect(success.output<string>()).resolves.toBe('workflow_activity_other');

    const failure = await WorkflowStub.make(TestFailingWorkflow);
    await expect(failure.start(true)).rejects.toThrow('failed');
  });

  it('runs simple and timer workflows', async () => {
    const simple = await WorkflowStub.make(TestSimpleWorkflow);
    await simple.start();
    await expect(simple.output<string>()).resolves.toBe('workflow_activity');

    const timer = await WorkflowStub.make(TestTimerWorkflow);
    await timer.start(0.01);
    await expect(timer.output<string>()).resolves.toBe('workflow');
  });

  it('runs exception workflow where activity retries once', async () => {
    const workflow = await WorkflowStub.make(TestExceptionWorkflow);
    await workflow.start();
    await expect(workflow.output<string>()).resolves.toBe('workflow_activity_other');
  });

  it('runs heartbeat workflow', async () => {
    const workflow = await WorkflowStub.make(TestHeartbeatWorkflow);
    await workflow.start();
    await expect(workflow.output<string>()).resolves.toBe('workflow_activity_other');
  });

  it('propagates timeouts and retry errors', async () => {
    const timeoutWorkflow = await WorkflowStub.make(TestTimeoutWorkflow);
    await expect(timeoutWorkflow.start()).rejects.toThrow('Activity timeout');

    const retriesWorkflow = await WorkflowStub.make(TestRetriesWorkflow);
    await expect(retriesWorkflow.start()).rejects.toThrow('failed');
  });

  it('handles non-retryable exception workflow', async () => {
    const workflow = await WorkflowStub.make(TestNonRetryableExceptionWorkflow);
    await expect(workflow.start()).rejects.toThrow('This is a non-retryable error');
  });

  it('runs saga workflow success and failure paths', async () => {
    const success = await WorkflowStub.make(TestSagaWorkflow);
    await success.start(false);
    await expect(success.output<string>()).resolves.toBe('saga_workflow');

    const failure = await WorkflowStub.make(TestSagaWorkflow);
    await expect(failure.start(true)).rejects.toThrow('saga');
  });

  it('validates side effects', async () => {
    const workflow = await WorkflowStub.make(TestSideEffectWorkflow);
    await expect(workflow.start()).rejects.toThrow('Unexpected side effect match');
  });
});
