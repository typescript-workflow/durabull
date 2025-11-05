import {
  TestStateMachineWorkflow,
  TestThrowOnReturnWorkflow,
  TestYieldNonPromiseWorkflow,
  TestModelWorkflow,
  TestModelNotFoundWorkflow,
  TestWebhookWorkflow,
} from '../fixtures/workflows';
import {
  TestActivity,
  TestInvalidActivity,
  TestEnum,
} from '../fixtures/activities';
import { WorkflowStub } from '../../src';

jest.setTimeout(30000);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('State and model workflows', () => {
  it('drives the state machine workflow', async () => {
    const workflow = await WorkflowStub.make(TestStateMachineWorkflow);
  const startPromise = workflow.start();
  await sleep(5);
    await workflow.submit();
  await sleep(5);
    await workflow.approve();
    await startPromise;
    await expect(workflow.output<string>()).resolves.toBe('approved');
  });

  it('returns complex objects and handles non-promise yields', async () => {
    const throwWorkflow = await WorkflowStub.make(TestThrowOnReturnWorkflow);
    await throwWorkflow.start();
    const raw = await throwWorkflow.output<{ valid(): boolean }>();
    expect(raw.valid()).toBe(false);

    const yieldWorkflow = await WorkflowStub.make(TestYieldNonPromiseWorkflow);
    await yieldWorkflow.start();
    await expect(yieldWorkflow.output()).resolves.toBeUndefined();
  });

  it('runs model workflows', async () => {
    const modelWorkflow = await WorkflowStub.make(TestModelWorkflow);
    await modelWorkflow.start({ id: 456 });
    await expect(modelWorkflow.output<number>()).resolves.toBe(456);

    const modelNotFound = await WorkflowStub.make(TestModelNotFoundWorkflow);
    await modelNotFound.start({ id: 'log-123' });
    await expect(modelNotFound.output()).resolves.toBeUndefined();
  });

  it('runs webhook workflow with cancel signal', async () => {
    const workflow = await WorkflowStub.make(TestWebhookWorkflow);
    const startPromise = workflow.start(true);
    setTimeout(() => {
      void workflow.cancel();
    }, 15);
    await startPromise;
    await expect(workflow.output<string>()).resolves.toBe('workflow_activity_other');
  });

  it('instantiates activities and enums directly', async () => {
    const activity = new TestActivity();
    await expect(activity.execute()).resolves.toBe('activity');

    const invalid = new TestInvalidActivity();
    await expect(invalid.execute()).rejects.toThrow('execute() must be implemented');

    expect([TestEnum.First, TestEnum.Second, TestEnum.Third]).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
