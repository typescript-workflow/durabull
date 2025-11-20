import { Worker, Job, UnrecoverableError } from 'bullmq';
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
  const durabullInstance = instance || Durabull.getActive();
  if (!durabullInstance) {
    throw new Error('Durabull instance not initialized. Call new Durabull(config) first or pass instance to startActivityWorker.');
  }
  const initialConfig = durabullInstance.getConfig();
  const storage = getStorage();
  
  // Initialize queues if not already initialized
  initQueues(
    initialConfig.redisUrl,
    initialConfig.queues.workflow,
    initialConfig.queues.activity
  );
  
  const queues = getQueues();
  const logger = createLoggerFromConfig(initialConfig.logger);
  
  const connection = new Redis(initialConfig.redisUrl, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker(
    initialConfig.queues.activity,
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
                // We can't easily throw from here to stop the job, but we can log it.
                // The job will eventually timeout if we stop updating heartbeat?
                // Actually, we should probably throw if we are inside the execution?
                // But this is async.
                // TODO: Implement cancellation via AbortController or similar mechanism
              }
            }
          }, checkInterval);
          
          await context.heartbeat();
        }

        try {
          let result: unknown;
          
          if (activity.timeout && activity.timeout > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            result = await (activity as any)._executeWithTimeout(activity.timeout * 1000, ...args);
          } else {
            result = await activity.execute(...args);
          }

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

            throw new UnrecoverableError(error.message);
          }

          // For regular errors, we let BullMQ handle the retry if attempts remain.
          // But if this was the last attempt, we need to record the failure.
          // BullMQ doesn't tell us easily if this is the last attempt BEFORE we throw.
          // But we can check job.opts.attempts vs job.attemptsMade.
          
          const maxAttempts = job.opts.attempts || 1;
          
          // If this is the last retry attempt, record the failure.
          if (job.attemptsMade >= maxAttempts) {
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        backoffStrategy: (attemptsMade: number, _type?: string, _err?: Error, job?: any) => {
          const activityJob = job as Job<ActivityJobData>;
          if (activityJob?.data?.retryOptions?.backoff && Array.isArray(activityJob.data.retryOptions.backoff) && activityJob.data.retryOptions.backoff.length > 0) {
            const backoff = activityJob.data.retryOptions.backoff;
            // attemptsMade is 1-based. For first retry (attemptsMade=1), use index 0.
            const index = Math.max(0, Math.min(attemptsMade - 1, backoff.length - 1));
            // Ensure index is within bounds and value is a number
            if (index >= 0 && index < backoff.length && typeof backoff[index] === 'number' && !isNaN(backoff[index])) {
              return backoff[index] * 1000;
            }
          }

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
  
  worker.on('closed', async () => {
    await connection.quit();
    logger.info('[ActivityWorker] Connection closed');
  });

  logger.info('[ActivityWorker] Started');
  return worker;
}
