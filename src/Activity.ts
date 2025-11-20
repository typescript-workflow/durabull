import { NonRetryableError } from './errors';

export interface ActivityConfig {
  queue?: string;
  connection?: { redisUrl?: string };
}

export interface ActivityContext {
  workflowId: string;
  activityId: string;
  attempt: number;
  heartbeat: () => void | Promise<void>;
  signal?: AbortSignal;
}

export abstract class Activity<TArgs extends unknown[] = unknown[], TResult = unknown> {
  tries?: number = 0; // 0 = retry forever
  timeout?: number = 0; // seconds, 0 = no limit
  queue?: string;
  connection?: { redisUrl?: string };

  private context?: ActivityContext;
  private lastHeartbeat: number = Date.now();

  abstract execute(...args: TArgs): Promise<TResult>;

  backoff(): number[] {
    return [1, 2, 5, 10, 30, 60, 120];
  }

  protected heartbeat(): void {
    this.lastHeartbeat = Date.now();
    if (this.context) {
      void this.context.heartbeat();
    }
  }

  protected workflowId(): string {
    if (!this.context) {
      throw new Error('workflowId() can only be called during activity execution');
    }
    return this.context.workflowId;
  }

  protected get signal(): AbortSignal | undefined {
    return this.context?.signal;
  }

  _setContext(context: ActivityContext) {
    this.context = context;
    this.lastHeartbeat = Date.now();
  }

  _getLastHeartbeat(): number {
    return this.lastHeartbeat;
  }

  async _executeWithRetry(...args: TArgs): Promise<TResult> {
    const maxAttempts = this.tries === 0 ? 1000000 : (this.tries || 1);
    const backoffSchedule = this.backoff();
    
    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt < maxAttempts) {
      try {
        if (this.context) {
          this.context.attempt = attempt;
        }

        if (this.timeout && this.timeout > 0) {
          const timeoutMs = this.timeout * 1000;
          return await new Promise<TResult>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`Activity timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            this.execute(...args)
              .then(result => {
                clearTimeout(timer);
                resolve(result);
              })
              .catch(error => {
                clearTimeout(timer);
                reject(error);
              });
          });
        }

        return await this.execute(...args);
      } catch (error) {
        lastError = error as Error;

        if (error instanceof NonRetryableError) {
          throw error;
        }

        attempt++;

        if (attempt >= maxAttempts) {
          break;
        }

        const backoffIndex = Math.min(attempt - 1, backoffSchedule.length - 1);
        const delaySec = backoffSchedule[backoffIndex] || backoffSchedule[backoffSchedule.length - 1];
        const delayMs = delaySec * 1000;

        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError || new Error('Activity execution failed');
  }
}
