import {
  TestChildWorkflow,
  TestChildExceptionWorkflow,
  TestChildTimerWorkflow,
  TestParentWorkflow,
  TestParentAsyncWorkflow,
  TestParentExceptionWorkflow,
  TestParentTimerWorkflow,
} from '../fixtures/workflows';
import { WorkflowStub } from '../../src';

jest.setTimeout(30000);

describe('Child workflow orchestration', () => {
  it('runs TestChildWorkflow', async () => {
    const workflow = await WorkflowStub.make(TestChildWorkflow);
    await workflow.start();
    const output = await workflow.output<string>();
    expect(output).toBe('other');
  });

  it('handles TestChildExceptionWorkflow success and failure', async () => {
    const success = await WorkflowStub.make(TestChildExceptionWorkflow);
    await success.start(false);
    await expect(success.output<string>()).resolves.toBe('other');

    const failure = await WorkflowStub.make(TestChildExceptionWorkflow);
    await expect(failure.start(true)).rejects.toThrow('failed');
  });

  it('runs TestChildTimerWorkflow', async () => {
    const workflow = await WorkflowStub.make(TestChildTimerWorkflow);
    await workflow.start(0.01);
    const output = await workflow.output<string>();
    expect(output).toBe('other');
  });

  it('runs parent workflows', async () => {
    const parent = await WorkflowStub.make(TestParentWorkflow);
    await parent.start();
    await expect(parent.output<string>()).resolves.toBe('workflow_activity_other');

    const parentAsync = await WorkflowStub.make(TestParentAsyncWorkflow);
    await parentAsync.start();
    await expect(parentAsync.output<string>()).resolves.toBe('workflow_activity_other');
  });

  it('handles parent exception workflow', async () => {
    const success = await WorkflowStub.make(TestParentExceptionWorkflow);
    await success.start(false);
    await expect(success.output<string>()).resolves.toBe('workflow_activity_other');

    const failure = await WorkflowStub.make(TestParentExceptionWorkflow);
    await expect(failure.start(true)).rejects.toThrow('failed');
  });

  it('executes parent timer workflow', async () => {
    const workflow = await WorkflowStub.make(TestParentTimerWorkflow);
    await workflow.start(0.01);
    await expect(workflow.output<string>()).resolves.toBe('workflow_activity_other');
  });
});
