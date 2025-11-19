/*
 * Integration tests for production features using real Redis and workers
 * These tests require a running Redis instance
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
import { Worker } from 'bullmq';

jest.setTimeout(60000);

let workflowWorker: Worker;
let activityWorker: Worker;
let durabull: Durabull;
const testQueuePrefix = `test-integration-${Date.now()}`;

const lifecycleEvents: Array<{ type: string; id: string; name: string }> = [];

beforeAll(async () => {
  durabull = new Durabull({
    redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
    queues: {
      workflow: `${testQueuePrefix}-workflow`,
      activity: `${testQueuePrefix}-activity`,
    },
    lifecycleHooks: {
      workflow: {
        onStart: async (id, name) => {
          lifecycleEvents.push({ type: 'workflow:start', id, name });
        },
        onComplete: async (id, name) => {
          lifecycleEvents.push({ type: 'workflow:complete', id, name });
        },
        onFailed: async (id, name) => {
          lifecycleEvents.push({ type: 'workflow:failed', id, name });
        },
      },
      activity: {
        onStart: async (_workflowId, activityId, activityName) => {
          lifecycleEvents.push({ type: 'activity:start', id: activityId, name: activityName });
        },
        onComplete: async (_workflowId, activityId, activityName) => {
          lifecycleEvents.push({ type: 'activity:complete', id: activityId, name: activityName });
        },
        onFailed: async (_workflowId, activityId, activityName, _error) => {
          lifecycleEvents.push({ type: 'activity:failed', id: activityId, name: activityName });
        },
      },
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
  
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { closeQueues } = require('../../src/queues');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { closeStorage } = require('../../src/runtime/storage');
  await closeQueues();
  await closeStorage();
  
  await new Promise((resolve) => setTimeout(resolve, 1000));
});

describe('Integration: String-Based Workflow Dispatch with Workers', () => {
  class IntegrationTestWorkflow extends Workflow<[string], string> {
    async *execute(input: string): AsyncGenerator<unknown, string, unknown> {
      const result = yield ActivityStub.make('IntegrationTestActivity', input);
      return `workflow: ${result}`;
    }
  }

  class IntegrationTestActivity extends Activity<[string], string> {
    tries = 2;

    async execute(input: string): Promise<string> {
      return `activity: ${input}`;
    }
  }

  beforeAll(() => {
    durabull.registerWorkflow('IntegrationTestWorkflow', IntegrationTestWorkflow);
    durabull.registerActivity('IntegrationTestActivity', IntegrationTestActivity);
  });

  it('should execute workflow end-to-end with string-based dispatch', async () => {
    const wf = await WorkflowStub.make('IntegrationTestWorkflow');
    await wf.start('test-input');

    let attempts = 0;
    while ((await wf.status()) !== 'completed' && (await wf.status()) !== 'failed' && attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      attempts++;
    }

    expect(await wf.status()).toBe('completed');
    expect(await wf.output()).toBe('workflow: activity: test-input');
  });

  it('should support loading workflow by ID', async () => {
    const wf = await WorkflowStub.make('IntegrationTestWorkflow', { id: 'test-load-123' });
    await wf.start('load-test');

    let attempts = 0;
    while ((await wf.status()) !== 'completed' && attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      attempts++;
    }

    const loaded = await WorkflowStub.load('test-load-123');
    expect(loaded.id()).toBe('test-load-123');
    expect(await loaded.status()).toBe('completed');
    expect(await loaded.output()).toBe('workflow: activity: load-test');
  });
});

describe('Integration: Lifecycle Hooks with Workers', () => {
  class HookTestWorkflow extends Workflow<[string], string> {
    async *execute(input: string): AsyncGenerator<unknown, string, unknown> {
      if (input === 'fail') {
        throw new Error('Intentional failure');
      }
      const result = yield ActivityStub.make('HookTestActivity', input);
      return result as string;
    }
  }

  class HookTestActivity extends Activity<[string], string> {
    async execute(input: string): Promise<string> {
      return `activity: ${input}`;
    }
  }

  beforeAll(() => {
    durabull.registerWorkflow('HookTestWorkflow', HookTestWorkflow);
    durabull.registerActivity('HookTestActivity', HookTestActivity);
  });

  it('should trigger lifecycle hooks for successful workflow', async () => {
    const initialEvents = lifecycleEvents.length;
    const wf = await WorkflowStub.make('HookTestWorkflow');
    await wf.start('success');

    let attempts = 0;
    while ((await wf.status()) !== 'completed' && attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      attempts++;
    }

    expect(await wf.status()).toBe('completed');

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const newEvents = lifecycleEvents.slice(initialEvents);
    
    expect(newEvents.some((e) => e.type === 'workflow:start')).toBe(true);
    expect(newEvents.some((e) => e.type === 'activity:start')).toBe(true);
    expect(newEvents.some((e) => e.type === 'activity:complete')).toBe(true);
    expect(newEvents.some((e) => e.type === 'workflow:complete')).toBe(true);
  });

  it('should trigger onFailed hook for failed workflow', async () => {
    const initialEvents = lifecycleEvents.length;
    const wf = await WorkflowStub.make('HookTestWorkflow');
    await wf.start('fail');

    let attempts = 0;
    while ((await wf.status()) !== 'failed' && attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      attempts++;
    }

    expect(await wf.status()).toBe('failed');

    await new Promise((resolve) => setTimeout(resolve, 500));

    const newEvents = lifecycleEvents.slice(initialEvents);
    
    expect(newEvents.some((e) => e.type === 'workflow:start')).toBe(true);
    expect(newEvents.some((e) => e.type === 'workflow:failed')).toBe(true);
  });
});

describe('Integration: Per-Invocation Retry Overrides', () => {
  let attemptCount = 0;

  class RetryOverrideWorkflow extends Workflow<[number], string> {
    async *execute(maxRetries: number): AsyncGenerator<unknown, string, unknown> {
      const result = yield ActivityStub.make('RetryOverrideActivity', maxRetries, {
        tries: maxRetries,
      });
      return result as string;
    }
  }

  class RetryOverrideActivity extends Activity<[number], string> {
    tries = 1;

    async execute(maxRetries: number): Promise<string> {
      attemptCount++;
      if (attemptCount < maxRetries) {
        throw new Error('Retry needed');
      }
      return `succeeded after ${attemptCount} attempts`;
    }
  }

  beforeAll(() => {
    durabull.registerWorkflow('RetryOverrideWorkflow', RetryOverrideWorkflow);
    durabull.registerActivity('RetryOverrideActivity', RetryOverrideActivity);
  });

  it('should respect per-invocation retry override', async () => {
    attemptCount = 0;
    
    const wf = await WorkflowStub.make('RetryOverrideWorkflow');
    await wf.start(3);

    let attempts = 0;
    while ((await wf.status()) !== 'completed' && attempts < 100) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      attempts++;
    }

    expect(await wf.status()).toBe('completed');
    expect(await wf.output()).toBe('succeeded after 3 attempts');
  });
});
