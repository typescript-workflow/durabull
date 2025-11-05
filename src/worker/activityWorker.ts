/**
 * Activity worker implementation
 * 
 * Logs are routed through the configurable Durabull logger hook for observability.
 */

import { Worker, Job } from 'bullmq';
import { Durabull } from '../config/global';
import { getStorage } from '../runtime/storage';
import { getQueues } from '../queues';
import { NonRetryableError } from '../errors';
import { Redis } from 'ioredis';
import { Activity, ActivityContext } from '../Activity';
import { getLogger } from '../runtime/logger';

/**
 * Activity registry - maps class names to constructors
 */
const activityRegistry = new Map<string, new () => Activity>();

/**
 * Register an activity class
 */
export function registerActivity(name: string, ActivityClass: new () => Activity): void {
  activityRegistry.set(name, ActivityClass);
}

/**
 * Resolve activity class by name
 */
export function resolveActivity(name: string): (new () => Activity) | null {
  return activityRegistry.get(name) || null;
}

/**
 * Job data for activity execution
 */
interface ActivityJobData {
  workflowId: string;
  activityClass: string;
  activityId: string;
  args: unknown[];
}

/**
 * Start the activity worker
 */
export function startActivityWorker(): Worker {
  const config = Durabull.getConfig();
  const storage = getStorage();
  const queues = getQueues();
  const logger = getLogger();
  
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker(
    config.queues!.activity!,
    async (job: Job<ActivityJobData>) => {
      const { workflowId, activityClass, activityId, args } = job.data;

  logger.info(`[ActivityWorker] Processing activity ${activityId} for workflow ${workflowId}`);

      // Acquire lock to prevent concurrent execution
      const lockAcquired = await storage.acquireLock(workflowId, `activity:${activityId}`, 300);
      if (!lockAcquired) {
        logger.debug(`[ActivityWorker] Activity ${activityId} is already running, skipping`);
        return;
      }

      try {
    // Resolve activity class
    const ActivityClass = resolveActivity(activityClass);
        if (!ActivityClass) {
          throw new Error(`Activity class ${activityClass} not registered`);
        }

    // Instantiate activity
    const activity = new ActivityClass();

    // Create context
    const context: ActivityContext = {
          workflowId,
          activityId,
          attempt: job.attemptsMade,
          heartbeat: async () => {
            // Refresh heartbeat in Redis
            const timeout = activity.timeout || 300; // Default 5 minutes
            await storage.refreshHeartbeat(workflowId, activityId, timeout);
          },
        };

        activity._setContext(context);

        // Setup heartbeat monitoring if timeout is set
        let heartbeatInterval: NodeJS.Timeout | null = null;
        if (activity.timeout && activity.timeout > 0) {
          const checkInterval = Math.max(activity.timeout * 1000 / 2, 1000); // Check at half the timeout
          heartbeatInterval = setInterval(async () => {
            const lastHeartbeat = await storage.checkHeartbeat(workflowId, activityId);
            if (lastHeartbeat) {
              const elapsed = Date.now() - lastHeartbeat;
              if (elapsed > activity.timeout! * 1000) {
                logger.error(`[ActivityWorker] Activity ${activityId} heartbeat timeout`);
                clearInterval(heartbeatInterval!);
                throw new Error('Activity heartbeat timeout');
              }
            }
          }, checkInterval);
          
          // Initial heartbeat
          await context.heartbeat();
        }

        try {
          // Execute activity with retry logic
          const result = await activity._executeWithRetry(...args);

          // Clear heartbeat monitoring
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
          }

          // Append success event to history
          await storage.appendEvent(workflowId, {
            type: 'activity',
            id: activityId,
            ts: Date.now(),
            result,
          });

          // Enqueue workflow resume job
          await queues.workflow.add('resume', {
            workflowId,
            isResume: true,
          });

          logger.info(`[ActivityWorker] Activity ${activityId} completed`);
          return result;
        } catch (error) {
          // Clear heartbeat monitoring
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
          }

          // Check if error is non-retryable
          if (error instanceof NonRetryableError) {
            logger.error(`[ActivityWorker] Activity ${activityId} failed with non-retryable error`, error);
            
            // Append error event to history
            await storage.appendEvent(workflowId, {
              type: 'activity',
              id: activityId,
              ts: Date.now(),
              error: {
                message: error.message,
                stack: error.stack,
                nonRetryable: true,
              },
            });

            // Enqueue workflow resume job
            await queues.workflow.add('resume', {
              workflowId,
              isResume: true,
            });

            throw error; // Don't retry
          }

          // For retryable errors, let BullMQ handle retries
          const maxAttempts = activity.tries === 0 ? 1000000 : (activity.tries || 1);
          if (job.attemptsMade >= maxAttempts - 1) {
            // Final attempt failed
            logger.error(`[ActivityWorker] Activity ${activityId} failed after all retries`, error);
            
            // Append error event to history
            await storage.appendEvent(workflowId, {
              type: 'activity',
              id: activityId,
              ts: Date.now(),
              error: {
                message: (error as Error).message,
                stack: (error as Error).stack,
              },
            });

            // Enqueue workflow resume job
            await queues.workflow.add('resume', {
              workflowId,
              isResume: true,
            });
          }

          throw error; // Propagate for BullMQ retry logic
        }
      } finally {
        // Release lock
        await storage.releaseLock(workflowId, `activity:${activityId}`);
      }
    },
    {
      connection,
      settings: {
        // Backoff settings for retries
        backoffStrategy: (attemptsMade: number) => {
          const backoffSchedule = [1, 2, 5, 10, 30, 60, 120];
          const index = Math.min(attemptsMade, backoffSchedule.length - 1);
          return backoffSchedule[index] * 1000;
        },
      },
    }
  );

  worker.on('completed', (job: Job) => {
    logger.info(`[ActivityWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(`[ActivityWorker] Job ${job?.id} failed`, err);
  });

  logger.info('[ActivityWorker] Started');
  return worker;
}
