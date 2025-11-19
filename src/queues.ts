/**
 * BullMQ queue management
 */

import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { Durabull } from './config/global';

/**
 * Queue instances
 */
interface Queues {
  workflow: Queue;
  activity: Queue;
  workflowEvents: QueueEvents;
  activityEvents: QueueEvents;
  connection: Redis;
}

let queues: Queues | null = null;

/**
 * Initialize queues with explicit configuration
 */
export function initQueues(redisUrl: string, workflowQueue: string, activityQueue: string): Queues {
  if (queues) {
    // If already initialized, check if config matches.
    // If it does, return existing. If not, throw error to prevent leaks/confusion.
    // Note: We can't easily check redisUrl equality due to potential formatting differences,
    // but we can check queue names.
    if (queues.workflow.name === workflowQueue && queues.activity.name === activityQueue) {
      return queues;
    }
    throw new Error('Queues already initialized with different configuration. Call closeQueues() first.');
  }

  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  queues = {
    workflow: new Queue(workflowQueue, { connection }),
    activity: new Queue(activityQueue, { connection }),
    workflowEvents: new QueueEvents(workflowQueue, { connection }),
    activityEvents: new QueueEvents(activityQueue, { connection }),
    connection,
  };
  
  return queues;
}

/**
 * Get queue instances (must call initQueues first in durable mode)
 */
export function getQueues(): Queues {
  if (!queues) {
    const instance = Durabull.getActive();
    
    if (instance) {
      const config = instance.getConfig();
      return initQueues(
        config.redisUrl,
        config.queues.workflow,
        config.queues.activity
      );
    }
    
    return initQueues('redis://localhost:6379', 'durabull:workflow', 'durabull:activity');
  }
  return queues;
}

/**
 * Close all queue connections
 */
export async function closeQueues(): Promise<void> {
  if (queues) {
    await queues.workflow.close();
    await queues.activity.close();
    await queues.workflowEvents.close();
    await queues.activityEvents.close();
    await queues.connection.quit();
    queues = null;
  }
}
