/**
 * Test for cursor persistence fix
 * Verifies that activity cursors are properly initialized from history
 */

import { ReplayEngine } from '../../src/runtime/ReplayEngine';
import { Workflow } from '../../src/Workflow';
import { Activity } from '../../src/Activity';
import { ActivityStub } from '../../src/ActivityStub';
import { Durabull } from '../../src/config/global';
import { initQueues, getQueues } from '../../src/queues';
import { RedisStorage, setStorage } from '../../src/runtime/storage';

jest.setTimeout(10000);

class TestActivity1 extends Activity<[], string> {
  async execute(): Promise<string> {
    return 'activity1';
  }
}

class TestActivity2 extends Activity<[], string> {
  async execute(): Promise<string> {
    return 'activity2';
  }
}

class TestActivity3 extends Activity<[], string> {
  async execute(): Promise<string> {
    return 'activity3';
  }
}

class MultiActivityWorkflow extends Workflow<[], string> {
  // eslint-disable-next-line require-yield
  async *execute(): AsyncGenerator<unknown, string, unknown> {
    const r1 = (yield ActivityStub.make(TestActivity1)) as string;
    const r2 = (yield ActivityStub.make(TestActivity2)) as string;
    const r3 = (yield ActivityStub.make(TestActivity3)) as string;
    return `${r1}-${r2}-${r3}`;
  }
}

describe('Cursor Persistence Fix', () => {
  let durabull: Durabull;
  const queuedActivities: Array<{ activityId: string; activityClass: string }> = [];

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
    
    durabull = new Durabull({
      redisUrl,
      queues: {
        workflow: `test-cursor-persist-${Date.now()}-workflow`,
        activity: `test-cursor-persist-${Date.now()}-activity`,
      },
    });
    
    durabull.setActive();
    durabull.registerActivity('TestActivity1', TestActivity1);
    durabull.registerActivity('TestActivity2', TestActivity2);
    durabull.registerActivity('TestActivity3', TestActivity3);
    durabull.registerWorkflow('MultiActivityWorkflow', MultiActivityWorkflow);

    const config = durabull.getConfig();
    await initQueues(config.redisUrl, config.queues.workflow, config.queues.activity);
    setStorage(new RedisStorage(config.redisUrl));
  });

  beforeEach(() => {
    queuedActivities.length = 0;
    
    const queues = getQueues();
    const originalAdd = queues.activity.add.bind(queues.activity);
    queues.activity.add = jest.fn(async (jobName, data, opts) => {
      queuedActivities.push({
        activityId: data.activityId,
        activityClass: data.activityClass,
      });
      return originalAdd(jobName, data, opts);
    }) as typeof queues.activity.add;
  });

  it('should initialize activityCursor from history to prevent ID collisions', async () => {
    const workflow = new MultiActivityWorkflow();
    const record = {
      id: 'test-cursor-init',
      class: 'MultiActivityWorkflow',
      status: 'running' as const,
      args: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Simulate that act-0 and act-1 already completed
    const history = {
      events: [
        {
          type: 'activity' as const,
          id: 'act-0',
          ts: Date.now(),
          result: 'activity1',
        },
        {
          type: 'activity' as const,
          id: 'act-1',
          ts: Date.now(),
          result: 'activity2',
        },
      ],
      cursor: 2,
    };

    queuedActivities.length = 0;

    try {
      await ReplayEngine.run({
        workflowId: 'test-cursor-init',
        workflow,
        record,
        history,
        signals: [],
        isResume: true,
      });
    } catch (error) {
      // Expected to throw WorkflowWaitError
    }

    // CRITICAL: The third activity should get act-2, NOT act-0 or act-1
    expect(queuedActivities.length).toBe(1);
    expect(queuedActivities[0]).toEqual({
      activityId: 'act-2',
      activityClass: 'TestActivity3',
    });
  });

  it('should not reuse activity IDs across replays', async () => {
    const record = {
      id: 'test-no-reuse',
      class: 'MultiActivityWorkflow',
      status: 'pending' as const,
      args: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // First execution - no history
    queuedActivities.length = 0;
    try {
      await ReplayEngine.run({
        workflowId: 'test-no-reuse',
        workflow: new MultiActivityWorkflow(),
        record,
        history: { events: [], cursor: 0 },
        signals: [],
        isResume: false,
      });
    } catch (error) {
      // Expected
    }

    expect(queuedActivities[0].activityId).toBe('act-0');

    // Second execution - act-0 completed
    const history1 = {
      events: [
        {
          type: 'activity' as const,
          id: 'act-0',
          ts: Date.now(),
          result: 'activity1',
        },
      ],
      cursor: 1,
    };

    queuedActivities.length = 0;
    try {
      await ReplayEngine.run({
        workflowId: 'test-no-reuse',
        workflow: new MultiActivityWorkflow(),
        record,
        history: history1,
        signals: [],
        isResume: true,
      });
    } catch (error) {
      // Expected
    }

    // Should queue act-1, NOT reuse act-0
    expect(queuedActivities[0].activityId).toBe('act-1');
    expect(queuedActivities[0].activityClass).toBe('TestActivity2');
  });
});
