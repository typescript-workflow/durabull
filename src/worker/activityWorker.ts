import { Worker, Job } from 'bullmq';
import { Durabull } from '../config/global';
import { getStorage } from '../runtime/storage';
import { initQueues, getQueues } from '../queues';
import { NonRetryableError } from '../errors';
import { Redis } from 'ioredis';
import { ActivityContext } from '../Activity';
import { createLoggerFromConfig } from '../runtime/logger';

/**
 * Job data for activity execution
 */
interface ActivityJobData {
  workflowId: string;
  activityClass: string;
  activityId: string;
  args: unknown[];
  retryOptions?: {
    tries?: number;
    timeout?: number;
    backoff?: number[];
  };
}

/**
 * Start the activity worker
 */
export function startActivityWorker(instance?: Durabull): Worker {
  const durabullInstance = instance || (Durabull as any);
  const initialConfig = durabullInstance.getConfig();
  const storage = getStorage();
  
  // Initialize queues if not already initialized
  initQueues(
    initialConfig.redisUrl,
    initialConfig.queues!.workflow!,
    initialConfig.queues!.activity!
  );
  
  const queues = getQueues();
  const logger = createLoggerFromConfig(initialConfig.logger);
  
  const connection = new Redis(initialConfig.redisUrl, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker(
    initialConfig.queues!.activity!,
    async (job: Job<ActivityJobData>) => {
      const config = durabullInstance.getConfig();
      const { workflowId, activityClass, activityId, args, retryOptions } = job.data;

  logger.info(`[ActivityWorker] Processing activity ${activityId} (${activityClass}) for workflow ${workflowId}`);

      const lockAcquired = await storage.acquireLock(workflowId, `activity:${activityId}`, 300);
      if (!lockAcquired) {
        logger.debug(`[ActivityWorker] Activity ${activityId} is already running, skipping`);
        return;
      }

      try {
        const ActivityClass = durabullInstance.resolveActivity(activityClass);
        if (!ActivityClass) {
          throw new Error(`Activity "${activityClass}" not registered`);
        }

    const activity = new ActivityClass();
    
    if (retryOptions) {
      if (retryOptions.tries !== undefined) {
        activity.tries = retryOptions.tries;
      }
      if (retryOptions.timeout !== undefined) {
        activity.timeout = retryOptions.timeout;
      }
      if (retryOptions.backoff) {
        activity.backoff = () => retryOptions.backoff!;
      }
    }

    const context: ActivityContext = {
          workflowId,
          activityId,
          attempt: job.attemptsMade,
          heartbeat: async () => {
            const timeout = activity.timeout || 300; // Default 5 minutes
            await storage.refreshHeartbeat(workflowId, activityId, timeout);
          },
        };

        activity._setContext(context);

        if (config.lifecycleHooks?.activity?.onStart) {
          try {
            await config.lifecycleHooks.activity.onStart(workflowId, activityId, activityClass, args);
          } catch (hookError) {
            logger.error('Activity onStart hook failed', hookError);
          }
        } else {
          logger.debug(`[ActivityWorker] No onStart hook configured (has lifecycleHooks: ${!!config.lifecycleHooks}, has activity: ${!!config.lifecycleHooks?.activity})`);
        }

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
          
          await context.heartbeat();
        }

        try {
          const result = await activity._executeWithRetry(...args);

          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
          }

          await storage.appendEvent(workflowId, {
            type: 'activity',
            id: activityId,
            ts: Date.now(),
            result,
          });

          await queues.workflow.add('resume', {
            workflowId,
            isResume: true,
          });

          if (config.lifecycleHooks?.activity?.onComplete) {
            try {
              await config.lifecycleHooks.activity.onComplete(workflowId, activityId, activityClass, result);
            } catch (hookError) {
              logger.error('Activity onComplete hook failed', hookError);
            }
          }

          logger.info(`[ActivityWorker] Activity ${activityId} completed`);
          return result;
        } catch (error) {
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
          }

          if (error instanceof NonRetryableError) {
            logger.error(`[ActivityWorker] Activity ${activityId} failed with non-retryable error`, error);
            
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

            await queues.workflow.add('resume', {
              workflowId,
              isResume: true,
            });

            if (config.lifecycleHooks?.activity?.onFailed) {
              try {
                await config.lifecycleHooks.activity.onFailed(workflowId, activityId, activityClass, error);
              } catch (hookError) {
                logger.error('Activity onFailed hook failed', hookError);
              }
            }

            throw error;
          }

          const maxAttempts = activity.tries === 0 ? 1000000 : (activity.tries || 1);
          if (job.attemptsMade >= maxAttempts - 1) {
            logger.error(`[ActivityWorker] Activity ${activityId} failed after all retries`, error);
            
            await storage.appendEvent(workflowId, {
              type: 'activity',
              id: activityId,
              ts: Date.now(),
              error: {
                message: (error as Error).message,
                stack: (error as Error).stack,
              },
            });

            await queues.workflow.add('resume', {
              workflowId,
              isResume: true,
            });

            if (config.lifecycleHooks?.activity?.onFailed) {
              try {
                await config.lifecycleHooks.activity.onFailed(workflowId, activityId, activityClass, error as Error);
              } catch (hookError) {
                logger.error('Activity onFailed hook failed', hookError);
              }
            }
          }

          throw error;
        }
      } finally {
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
