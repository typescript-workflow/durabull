import type { Workflow } from '../Workflow';
import type { Activity } from '../Activity';

export interface WorkflowLifecycleHooks {
  onStart?: (workflowId: string, workflowName: string, args: unknown[]) => void | Promise<void>;
  onComplete?: (workflowId: string, workflowName: string, output: unknown) => void | Promise<void>;
  onFailed?: (workflowId: string, workflowName: string, error: Error) => void | Promise<void>;
  onWaiting?: (workflowId: string, workflowName: string) => void | Promise<void>;
  onContinued?: (workflowId: string, workflowName: string, newWorkflowId: string) => void | Promise<void>;
}

export interface ActivityLifecycleHooks {
  onStart?: (workflowId: string, activityId: string, activityName: string, args: unknown[]) => void | Promise<void>;
  onComplete?: (workflowId: string, activityId: string, activityName: string, result: unknown) => void | Promise<void>;
  onFailed?: (workflowId: string, activityId: string, activityName: string, error: Error) => void | Promise<void>;
}

export type QueueRouter = (workflowName: string, context?: Record<string, unknown>) => {
  workflow?: string;
  activity?: string;
};

export interface DurabullGlobalConfig {
  redisUrl: string;
  queues?: {
    workflow?: string;
    activity?: string;
  };
  queueRouter?: QueueRouter;
  serializer?: 'json' | 'base64';
  pruneAge?: string;
  webhooks?: {
    route?: string;
    auth?: {
      method: 'none' | 'token' | 'signature' | 'custom';
      header?: string;
      token?: string;
    };
  };
  logger?: DurabullLogger;
  lifecycleHooks?: {
    workflow?: WorkflowLifecycleHooks;
    activity?: ActivityLifecycleHooks;
  };
}

export interface DurabullLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

let activeInstance: Durabull | null = null;

export class Durabull {
  private config: DurabullGlobalConfig;
  private workflowRegistry = new Map<string, new () => Workflow<unknown[], unknown>>();
  private activityRegistry = new Map<string, new () => Activity<unknown[], unknown>>();

  constructor(config: DurabullGlobalConfig) {
    this.config = {
      ...config,
      queues: {
        workflow: config.queues?.workflow || 'durabull:workflow',
        activity: config.queues?.activity || 'durabull:activity',
      },
      serializer: config.serializer || 'json',
      pruneAge: config.pruneAge || '30 days',
      logger: config.logger,
      lifecycleHooks: config.lifecycleHooks,
      queueRouter: config.queueRouter,
    };
  }

  getConfig(): DurabullGlobalConfig {
    return this.config;
  }

  registerWorkflow(name: string, WorkflowClass: new () => Workflow<unknown[], unknown>): void {
    this.workflowRegistry.set(name, WorkflowClass);
  }

  resolveWorkflow(name: string): (new () => Workflow<unknown[], unknown>) | null {
    return this.workflowRegistry.get(name) || null;
  }

  registerActivity(name: string, ActivityClass: new () => Activity<unknown[], unknown>): void {
    this.activityRegistry.set(name, ActivityClass);
  }

  resolveActivity(name: string): (new () => Activity<unknown[], unknown>) | null {
    return this.activityRegistry.get(name) || null;
  }

  getQueues(workflowName?: string, context?: Record<string, unknown>): { workflow: string; activity: string } {
    if (this.config.queueRouter && workflowName) {
      const routed = this.config.queueRouter(workflowName, context);
      return {
        workflow: routed.workflow || this.config.queues!.workflow!,
        activity: routed.activity || this.config.queues!.activity!,
      };
    }
    return {
      workflow: this.config.queues!.workflow!,
      activity: this.config.queues!.activity!,
    };
  }

  setActive(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeInstance = this;
  }

  static getActive(): Durabull | null {
    return activeInstance;
  }
}
