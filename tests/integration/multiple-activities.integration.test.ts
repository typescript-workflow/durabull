/**
 * Integration test for bug fix: Incorrect Activity Class Queued During Workflow Execution
 * 
 * This test verifies that when a workflow yields multiple ActivityStub.make() calls
 * in sequence, each activity is executed as the correct activity type.
 * 
 * Bug Report: Activities at positions act-1, act-3, etc. were queued with wrong activityClass
 * Root Cause: activityId was generated inside async function after activityCursor incremented
 * Fix: Generate activityId synchronously before async function executes
 */

import {
  Durabull,
  WorkflowStub,
  ActivityStub,
  Workflow,
  Activity,
  startWorkflowWorker,
  startActivityWorker,
} from '../../src';
import { closeQueues } from '../../src/queues';
import { closeStorage } from '../../src/runtime/storage';
import { Worker } from 'bullmq';

jest.setTimeout(30000);

let workflowWorker: Worker;
let activityWorker: Worker;
let durabull: Durabull;
const testQueuePrefix = `test-multi-act-${Date.now()}`;

// Track which activities were executed
const executedActivities: Array<{ name: string; args: unknown[] }> = [];

const noop = () => {};

beforeAll(async () => {
  const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';

  durabull = new Durabull({
    redisUrl,
    queues: {
      workflow: `${testQueuePrefix}-workflow`,
      activity: `${testQueuePrefix}-activity`,
    },
    logger: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    },
  });

  durabull.setActive();

  workflowWorker = startWorkflowWorker(durabull);
  activityWorker = startActivityWorker(durabull);

  await new Promise((resolve) => setTimeout(resolve, 1000));
});

afterAll(async () => {
  if (workflowWorker) {
    await workflowWorker.close();
  }
  if (activityWorker) {
    await activityWorker.close();
  }
  
  await new Promise((resolve) => setTimeout(resolve, 1000));
  
  await closeQueues();
  await closeStorage();
  
  await new Promise((resolve) => setTimeout(resolve, 1000));
});

describe('Integration: Multiple Activities with Different Types', () => {
  // Test activities with different return types to catch type mismatches
  class UpdateStatusActivity extends Activity<[{ status: string }], void> {
    async execute({ status }: { status: string }): Promise<void> {
      executedActivities.push({ name: 'UpdateStatusActivity', args: [{ status }] });
    }
  }

  class GitCheckoutActivity extends Activity<[{ repo: string; sha: string }], { path: string }> {
    async execute({ repo, sha }: { repo: string; sha: string }): Promise<{ path: string }> {
      executedActivities.push({ name: 'GitCheckoutActivity', args: [{ repo, sha }] });
      return { path: `/tmp/${repo}/${sha}` };
    }
  }

  class CompileActivity extends Activity<[{ path: string }], { artifacts: string[] }> {
    async execute({ path }: { path: string }): Promise<{ artifacts: string[] }> {
      executedActivities.push({ name: 'CompileActivity', args: [{ path }] });
      return { artifacts: [`${path}/build/main.js`] };
    }
  }

  class DeployActivity extends Activity<[{ artifacts: string[] }], { url: string }> {
    async execute({ artifacts }: { artifacts: string[] }): Promise<{ url: string }> {
      executedActivities.push({ name: 'DeployActivity', args: [{ artifacts }] });
      return { url: 'https://example.com/deployed' };
    }
  }

  // Workflow that yields multiple activities in sequence
  class MultipleActivitiesWorkflow extends Workflow<[string, string], string> {
    // eslint-disable-next-line require-yield
    async *execute(repo: string, sha: string): AsyncGenerator<unknown, string, unknown> {
      // act-0: UpdateStatusActivity
      yield ActivityStub.make(UpdateStatusActivity, { status: 'checking_out' });
      
      // act-1: GitCheckoutActivity (BUG: was being queued as UpdateStatusActivity)
      const checkoutResult = (yield ActivityStub.make(GitCheckoutActivity, { 
        repo, 
        sha 
      })) as { path: string };
      
      // act-2: UpdateStatusActivity
      yield ActivityStub.make(UpdateStatusActivity, { status: 'compiling' });
      
      // act-3: CompileActivity (BUG: was being queued as UpdateStatusActivity)
      const compileResult = (yield ActivityStub.make(CompileActivity, { 
        path: checkoutResult.path 
      })) as { artifacts: string[] };
      
      // act-4: UpdateStatusActivity
      yield ActivityStub.make(UpdateStatusActivity, { status: 'deploying' });
      
      // act-5: DeployActivity
      const deployResult = (yield ActivityStub.make(DeployActivity, { 
        artifacts: compileResult.artifacts 
      })) as { url: string };
      
      // act-6: UpdateStatusActivity
      yield ActivityStub.make(UpdateStatusActivity, { status: 'completed' });
      
      return deployResult.url;
    }
  }

  beforeAll(() => {
    durabull.registerActivity('UpdateStatusActivity', UpdateStatusActivity);
    durabull.registerActivity('GitCheckoutActivity', GitCheckoutActivity);
    durabull.registerActivity('CompileActivity', CompileActivity);
    durabull.registerActivity('DeployActivity', DeployActivity);
    durabull.registerWorkflow('MultipleActivitiesWorkflow', MultipleActivitiesWorkflow);
  });

  beforeEach(() => {
    executedActivities.length = 0;
  });

  it('should execute all activities with correct types', async () => {
    const wf = await WorkflowStub.make('MultipleActivitiesWorkflow');
    await wf.start('test-repo', 'abc123');

    // Wait for workflow to complete
    let attempts = 0;
    while ((await wf.status()) !== 'completed' && (await wf.status()) !== 'failed' && attempts < 100) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      attempts++;
    }

    expect(await wf.status()).toBe('completed');
    expect(await wf.output()).toBe('https://example.com/deployed');

    // Verify all 7 activities executed in correct order
    expect(executedActivities).toHaveLength(7);
    
    expect(executedActivities[0].name).toBe('UpdateStatusActivity');
    expect(executedActivities[0].args).toEqual([{ status: 'checking_out' }]);

    // CRITICAL: This activity should be GitCheckoutActivity, not UpdateStatusActivity
    expect(executedActivities[1].name).toBe('GitCheckoutActivity');
    expect(executedActivities[1].args).toEqual([{ repo: 'test-repo', sha: 'abc123' }]);

    expect(executedActivities[2].name).toBe('UpdateStatusActivity');
    expect(executedActivities[2].args).toEqual([{ status: 'compiling' }]);

    // CRITICAL: This activity should be CompileActivity, not UpdateStatusActivity
    expect(executedActivities[3].name).toBe('CompileActivity');
    expect(executedActivities[3].args).toEqual([{ path: '/tmp/test-repo/abc123' }]);

    expect(executedActivities[4].name).toBe('UpdateStatusActivity');
    expect(executedActivities[4].args).toEqual([{ status: 'deploying' }]);

    expect(executedActivities[5].name).toBe('DeployActivity');
    expect(executedActivities[5].args).toEqual([{ artifacts: ['/tmp/test-repo/abc123/build/main.js'] }]);

    expect(executedActivities[6].name).toBe('UpdateStatusActivity');
    expect(executedActivities[6].args).toEqual([{ status: 'completed' }]);
  });

  it('should handle interleaved activity types correctly', async () => {
    class InterleavedWorkflow extends Workflow<[], string> {
      // eslint-disable-next-line require-yield
      async *execute(): AsyncGenerator<unknown, string, unknown> {
        yield ActivityStub.make(UpdateStatusActivity, { status: 'step1' });
        const r1 = (yield ActivityStub.make(GitCheckoutActivity, { repo: 'a', sha: '1' })) as { path: string };
        yield ActivityStub.make(UpdateStatusActivity, { status: 'step2' });
        const r2 = (yield ActivityStub.make(CompileActivity, { path: r1.path })) as { artifacts: string[] };
        yield ActivityStub.make(UpdateStatusActivity, { status: 'step3' });
        const r3 = (yield ActivityStub.make(DeployActivity, { artifacts: r2.artifacts })) as { url: string };
        return r3.url;
      }
    }

    durabull.registerWorkflow('InterleavedWorkflow', InterleavedWorkflow);

    executedActivities.length = 0;

    const wf = await WorkflowStub.make('InterleavedWorkflow');
    await wf.start();

    let attempts = 0;
    while ((await wf.status()) !== 'completed' && (await wf.status()) !== 'failed' && attempts < 100) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      attempts++;
    }

    expect(await wf.status()).toBe('completed');

    // Verify the pattern: Status, Git, Status, Compile, Status, Deploy
    expect(executedActivities).toHaveLength(6);
    expect(executedActivities[0].name).toBe('UpdateStatusActivity');
    expect(executedActivities[1].name).toBe('GitCheckoutActivity');
    expect(executedActivities[2].name).toBe('UpdateStatusActivity');
    expect(executedActivities[3].name).toBe('CompileActivity');
    expect(executedActivities[4].name).toBe('UpdateStatusActivity');
    expect(executedActivities[5].name).toBe('DeployActivity');
  });
});
