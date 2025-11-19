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
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  queues = {
    workflow: new Queue(workflowQueue, { connection: connection.duplicate() }),
    activity: new Queue(activityQueue, { connection: connection.duplicate() }),
    workflowEvents: new QueueEvents(workflowQueue, { connection: connection.duplicate() }),
    activityEvents: new QueueEvents(activityQueue, { connection: connection.duplicate() }),
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
        config.queues!.workflow!,
        config.queues!.activity!
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
