/**
 * BullMQ queue management
 */

import { Queue, QueueEvents } from 'bullmq';
import { Durabull } from './config/global';
import { Redis } from 'ioredis';

/**
 * Queue instances
 */
interface Queues {
  workflow: Queue;
  activity: Queue;
  workflowEvents: QueueEvents;
  activityEvents: QueueEvents;
}

let queues: Queues | null = null;

/**
 * Get or create queue instances
 */
export function getQueues(): Queues {
  if (!queues) {
    const config = Durabull.getConfig();
    const connection = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
    });

    queues = {
      workflow: new Queue(config.queues!.workflow!, { connection: connection.duplicate() }),
      activity: new Queue(config.queues!.activity!, { connection: connection.duplicate() }),
      workflowEvents: new QueueEvents(config.queues!.workflow!, { connection: connection.duplicate() }),
      activityEvents: new QueueEvents(config.queues!.activity!, { connection: connection.duplicate() }),
    };
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
    queues = null;
  }
}
