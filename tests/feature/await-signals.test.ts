import {
  TestWorkflow,
  TestAwaitWorkflow,
  TestAwaitWithTimeoutWorkflow,
  TestBadConnectionWorkflow,
  TestTimeTravelWorkflow,
  TestSignalExceptionWorkflow,
  TestSignalExceptionWorkflowLeader,
} from '../fixtures/workflows';
import { WorkflowStub } from '../../src';

jest.setTimeout(30000);

describe('Await and signal workflows', () => {
  it('runs TestWorkflow after cancel signal', async () => {
    const workflow = await WorkflowStub.make(TestWorkflow);
    await workflow.cancel();
    await workflow.start(false);
    const output = await workflow.output<string>();
    expect(output).toBe('workflow_activity_other');
  });

  it('runs TestAwaitWorkflow after signal', async () => {
    const workflow = await WorkflowStub.make(TestAwaitWorkflow);
    await workflow.cancel();
    await workflow.start();
    await expect(workflow.output<string>()).resolves.toBe('workflow');
  });

  it('handles TestAwaitWithTimeoutWorkflow', async () => {
    const success = await WorkflowStub.make(TestAwaitWithTimeoutWorkflow);
    await success.start(false);
    await expect(success.output<string>()).resolves.toBe('workflow');

    const timeout = await WorkflowStub.make(TestAwaitWithTimeoutWorkflow);
    await timeout.start(true);
    await expect(timeout.output<string>()).resolves.toBe('workflow_timed_out');
  });

  it('runs TestBadConnectionWorkflow with deferred cancel', async () => {
    const workflow = await WorkflowStub.make(TestBadConnectionWorkflow);
    const startPromise = workflow.start(true);
    setTimeout(() => {
      void workflow.cancel();
    }, 15);
    await startPromise;
    const output = await workflow.output<string>();
    expect(output).toBe('workflow_activity_other');
  });

  it('runs time-travel workflow with cancel', async () => {
    const workflow = await WorkflowStub.make(TestTimeTravelWorkflow);
    const startPromise = workflow.start();
    setTimeout(() => {
      void workflow.cancel();
    }, 15);
    await startPromise;
    await expect(workflow.output<string>()).resolves.toBe('workflow_activity_other');
  });

  it('retries after signals in exception workflows', async () => {
    const workflow = await WorkflowStub.make(TestSignalExceptionWorkflow);
    const startPromise = workflow.start();
    setTimeout(() => {
      void workflow.shouldRetrySignal();
    }, 15);
    await startPromise;
    await expect(workflow.output<boolean>()).resolves.toBe(true);

    const leader = await WorkflowStub.make(TestSignalExceptionWorkflowLeader);
    const leaderStart = leader.start();
    setTimeout(() => {
      void leader.shouldRetrySignal();
    }, 15);
    await leaderStart;
    await expect(leader.output<boolean>()).resolves.toBe(true);
  });
});
