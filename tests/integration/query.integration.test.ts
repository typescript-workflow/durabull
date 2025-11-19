
import {
  Durabull,
  WorkflowStub,
  Workflow,
  QueryMethod,
  startWorkflowWorker,
} from '../../src';
import { Worker } from 'bullmq';

jest.setTimeout(60000);

let workflowWorker: Worker;
let durabull: Durabull;
const testQueuePrefix = `test-query-${Date.now()}`;

beforeAll(async () => {
  durabull = new Durabull({
    redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
    queues: {
      workflow: `${testQueuePrefix}-workflow`,
      activity: `${testQueuePrefix}-activity`,
    },
  });

  durabull.setActive();
  workflowWorker = startWorkflowWorker(durabull);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});

afterAll(async () => {
  if (workflowWorker) {
    await workflowWorker.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  
  const { closeQueues } = require('../../src/queues');
  const { closeStorage } = require('../../src/runtime/storage');
  await closeQueues();
  await closeStorage();
});

describe('Integration: Workflow Queries', () => {
  class QueryTestWorkflow extends Workflow<[], string> {
    private count = 0;

    @QueryMethod()
    getCount(): number {
      return this.count;
    }

    async *execute(): AsyncGenerator<any, string, any> {
      this.count = 10;
      await WorkflowStub.timer(1);
      this.count = 20;
      return 'done';
    }
  }

  beforeAll(() => {
    durabull.registerWorkflow('QueryTestWorkflow', QueryTestWorkflow);
  });

  it('should query workflow state during execution', async () => {
    const wf = await WorkflowStub.make('QueryTestWorkflow');
    await wf.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    const count1 = await wf.query<any>(QueryTestWorkflow).getCount();
    expect(count1).toBe(10);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const count2 = await wf.query<any>(QueryTestWorkflow).getCount();
    expect(count2).toBe(20);
    
    expect(await wf.output()).toBe('done');
  });
});
