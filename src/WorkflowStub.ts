/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WorkflowStub - interface for controlling and executing workflows (Durable Mode Only)
 */

import { Workflow } from './Workflow';
import { getQueryMethods } from './decorators';
import { getStorage } from './runtime/storage';
import { getQueues } from './queues';
import { generateWorkflowId, generateSideEffectId, generateActivityId, generateTimerId } from './runtime/ids';
import { WorkflowRecord, WorkflowStatus } from './runtime/history';
import { Durabull } from './config/global';
import { createLoggerFromConfig } from './runtime/logger';
import { replayWorkflow } from './runtime/replayer';
import { WorkflowWaitError, WorkflowContinueAsNewError } from './errors';
import { getWorkflowContext, getVirtualTimestamp, runInWorkflowContext, WorkflowExecutionContext } from './runtime/context';

export { WorkflowStatus } from './runtime/history';
export { WorkflowWaitError, WorkflowContinueAsNewError } from './errors';

export interface WorkflowDispatchOptions {
  id?: string;
  queue?: string;
  queueContext?: Record<string, unknown>;
}

/**
 * WorkflowHandle - interface for interacting with a workflow instance
 */
export class WorkflowHandle<TArgs extends any[] = any[], TResult = any> {
  constructor(
    private workflowId: string,
    private workflowName: string
  ) {}

  id(): string {
    return this.workflowId;
  }

  async start(...args: TArgs): Promise<void> {
    const storage = getStorage();
    const queues = getQueues();
    const instance = Durabull.getActive();
    
    if (!instance) {
      throw new Error('No active Durabull instance');
    }
    
    const config = instance.getConfig();

    const record: WorkflowRecord = {
      id: this.workflowId,
      class: this.workflowName,
      status: 'pending',
      args,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    await storage.writeRecord(record);
    await storage.writeHistory(this.workflowId, { events: [], cursor: 0 });

    // Call onStart lifecycle hook
    if (config.lifecycleHooks?.workflow?.onStart) {
      try {
        await config.lifecycleHooks.workflow.onStart(this.workflowId, this.workflowName, args);
      } catch (error) {
        const logger = createLoggerFromConfig(config.logger);
        logger.error('Workflow onStart hook failed', error);
      }
    }

    await queues.workflow.add('start', {
      workflowId: this.workflowId,
      workflowName: this.workflowName,
      args,
      isResume: false,
    });
  }

  async status(): Promise<WorkflowStatus> {
    const storage = getStorage();
    const record = await storage.readRecord(this.workflowId);
    if (!record) {
      return 'pending';
    }
    return record.status;
  }

  async output(): Promise<TResult> {
    const storage = getStorage();
    const record = await storage.readRecord(this.workflowId);

    if (!record) {
      throw new Error(`Workflow ${this.workflowId} not found`);
    }

    if (record.status === 'failed') {
      throw new Error(record.error?.message || 'Workflow failed');
    }

    if (record.status !== 'completed') {
      throw new Error(`Workflow is ${record.status}, not completed`);
    }

    return record.output as TResult;
  }

  /**
   * Get query method proxy - queries access workflow state from storage
   */
  query<T extends Record<string, (...args: any[]) => any>>(WorkflowClass: new () => Workflow<any, any>): T {
    const queryMethods = getQueryMethods(WorkflowClass);
    const proxy: any = {};

    for (const methodName of queryMethods) {
      proxy[methodName] = async (...args: any[]) => {
        try {
          // Replay workflow to get current state
          const { workflow } = await replayWorkflow(this.workflowId, WorkflowClass);
          
          // Execute query on the replayed instance
          return (workflow as any)[methodName](...args);
        } catch (error) {
          const instance = Durabull.getActive();
          const logger = createLoggerFromConfig(instance?.getConfig().logger);
          logger.error('Query execution failed', error);
          throw error;
        }
      };
    }

    return proxy as T;
  }
}

/**
 * WorkflowStub - Static methods for workflow control
 */
export class WorkflowStub {
  /**
   * Create a new workflow handle
   */
  static async make<T extends Workflow<TArgs, TResult>, TArgs extends any[] = any[], TResult = any>(
    workflowClassOrName: (new () => T) | string,
    options?: WorkflowDispatchOptions
  ): Promise<WorkflowHandle<TArgs, TResult>> {
    const instance = Durabull.getActive();
    
    if (!instance) {
      throw new Error('No active Durabull instance. Create an instance and call setActive()');
    }
    
    let workflowName: string;

    if (typeof workflowClassOrName === 'string') {
      workflowName = workflowClassOrName;
      const resolved = instance.resolveWorkflow(workflowName);
      if (!resolved) {
        throw new Error(`Workflow "${workflowName}" not registered`);
      }
    } else {
      workflowName = workflowClassOrName.name;
    }

    const id = options?.id || generateWorkflowId();
    return new WorkflowHandle<TArgs, TResult>(id, workflowName);
  }

  /**
   * Load an existing workflow by ID
   */
  static async load<TArgs extends any[] = any[], TResult = any>(
    id: string
  ): Promise<WorkflowHandle<TArgs, TResult>> {
    const storage = getStorage();
    const record = await storage.readRecord(id);

    if (!record) {
      throw new Error(`Workflow ${id} not found`);
    }

    return new WorkflowHandle<TArgs, TResult>(id, record.class);
  }

  /**
   * Send a signal to a workflow
   */
  static async sendSignal(workflowId: string, signalName: string, payload: any[]): Promise<void> {
    const storage = getStorage();
    const queues = getQueues();

    await storage.pushSignal(workflowId, {
      name: signalName,
      payload,
      ts: Date.now(),
    });

    await queues.workflow.add('resume', {
      workflowId,
      isResume: true,
    });
  }

  /**
   * Get current time (replay-safe for workflows)
   */
  static now(): Date {
    const ctx = getWorkflowContext();
    if (!ctx) {
      return new Date();
    }

    const ts = getVirtualTimestamp(ctx.workflowId);
    return new Date(ts);
  }

  /**
   * Sleep for a duration (workflow timer)
   */
  static async timer(durationSeconds: number | string): Promise<void> {
    const seconds = typeof durationSeconds === 'string' 
      ? parseInt(durationSeconds, 10) 
      : durationSeconds;
    
    const ctx = getWorkflowContext();
    if (!ctx) {
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      return;
    }

    const storage = getStorage();
    const queues = getQueues();
    const timerId = WorkflowStub._generateTimerId();
    const history = ctx.history || await storage.readHistory(ctx.workflowId);

    if (history && !ctx.eventIndex) {
      ctx.eventIndex = new Map();
      for (const event of history.events) {
        if (event.id) {
          ctx.eventIndex.set(`${event.type}:${event.id}`, event);
        }
      }
    }

    if (history) {
      const firedEvent = ctx.eventIndex 
        ? ctx.eventIndex.get(`timer-fired:${timerId}`)
        : history.events.find((e) => e.type === 'timer-fired' && e.id === timerId);

      if (firedEvent) {
        return;
      }
    }

    const delayMs = Math.max(0, seconds * 1000);
    if (delayMs === 0) {
      return;
    }

    const startedEvent = ctx.eventIndex
      ? ctx.eventIndex.get(`timer-started:${timerId}`)
      : history?.events.find((e) => e.type === 'timer-started' && e.id === timerId);

    if (!startedEvent) {
      const event = {
        type: 'timer-started' as const,
        id: timerId,
        ts: Date.now(),
        delay: seconds,
      };
      
      await storage.appendEvent(ctx.workflowId, event);
      
      if (ctx.eventIndex) {
        ctx.eventIndex.set(`timer-started:${timerId}`, event);
      }
      
      const record = await storage.readRecord(ctx.workflowId);
      if (record) {
        record.status = 'waiting';
        record.waiting = {
          type: 'await',
          resumeAt: Date.now() + seconds * 1000,
        };
        record.updatedAt = Date.now();
        await storage.writeRecord(record);
      }

      await queues.workflow.add(
        'resume',
        {
          workflowId: ctx.workflowId,
          isResume: true,
          timerId, // Pass timerId to worker
        },
        {
          delay: seconds * 1000,
        }
      );
    }

    throw new WorkflowWaitError(`Timer ${timerId} waiting ${seconds}s`);
  }

  /**
   * Wait for a condition to become true
   */
  static async await(predicate: () => boolean): Promise<void> {
    if (predicate()) {
      return;
    }

    const ctx = getWorkflowContext();
    if (!ctx) {
      // Not in workflow context - poll
      while (!predicate()) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    const storage = getStorage();
    const queues = getQueues();
    
    // Update workflow to waiting status
    const record = await storage.readRecord(ctx.workflowId);
    if (record) {
      record.status = 'waiting';
      record.waiting = {
        type: 'await',
        resumeAt: Date.now() + 100, // Check again in 100ms
      };
      record.updatedAt = Date.now();
      await storage.writeRecord(record);
    }

    // Schedule resume
    await queues.workflow.add(
      'resume',
      {
        workflowId: ctx.workflowId,
        isResume: true,
      },
      {
        delay: 100,
      }
    );

    throw new WorkflowWaitError('Awaiting condition');
  }

  /**
   * Wait for condition with timeout
   */
  static async awaitWithTimeout(
    durationSeconds: number | string,
    predicate: () => boolean
  ): Promise<boolean> {
    if (predicate()) {
      return true;
    }

    const seconds = typeof durationSeconds === 'string'
      ? parseInt(durationSeconds, 10)
      : durationSeconds;

    const ctx = getWorkflowContext();
    if (!ctx) {
      // Not in workflow - use regular timeout
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start >= seconds * 1000) {
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return true;
    }

    const storage = getStorage();
    const queues = getQueues();
    const record = await storage.readRecord(ctx.workflowId);
    
    if (!record) {
      return false;
    }

    // Check if we've exceeded deadline
    const existingDeadline = record.waiting?.type === 'awaitWithTimeout'
      ? record.waiting.deadline
      : undefined;
    const deadline = existingDeadline ?? Date.now() + seconds * 1000;

    if (Date.now() >= deadline) {
      record.waiting = undefined;
      await storage.writeRecord(record);
      return false;
    }

    // Update to waiting
    record.status = 'waiting';
    record.waiting = {
      type: 'awaitWithTimeout',
      resumeAt: Date.now() + 100,
      deadline,
    };
    record.updatedAt = Date.now();
    await storage.writeRecord(record);

    // Schedule resume
    await queues.workflow.add(
      'resume',
      {
        workflowId: ctx.workflowId,
        isResume: true,
      },
      {
        delay: 100,
      }
    );

    throw new WorkflowWaitError('Awaiting with timeout');
  }

  /**
   * Continue as new workflow
   */
  static async continueAsNew(...args: any[]): Promise<never> {
    const ctx = getWorkflowContext();
    if (!ctx) {
      throw new Error('continueAsNew can only be called from within a workflow');
    }

    const storage = getStorage();
    const queues = getQueues();
    const newWorkflowId = generateWorkflowId();
    const now = Date.now();

    // Create new workflow record
    const newRecord: WorkflowRecord = {
      id: newWorkflowId,
      class: ctx.record.class,
      status: 'pending',
      args,
      createdAt: now,
      updatedAt: now,
      continuedFrom: ctx.workflowId,
    };

    await storage.writeRecord(newRecord);
    await storage.writeHistory(newWorkflowId, { events: [], cursor: 0 });

    // Update current workflow
    const currentRecord = await storage.readRecord(ctx.workflowId);
    if (currentRecord) {
      currentRecord.status = 'continued';
      currentRecord.continuedTo = newWorkflowId;
      currentRecord.waiting = undefined;
      currentRecord.updatedAt = now;
      await storage.writeRecord(currentRecord);
    }

    // Queue new workflow
    await queues.workflow.add('start', {
      workflowId: newWorkflowId,
      workflowName: ctx.record.class,
      args,
      isResume: false,
    });

    throw new WorkflowContinueAsNewError(newWorkflowId);
  }

  /**
   * Execute side effect (non-deterministic code)
   */
  static async sideEffect<T>(fn: () => T | Promise<T>): Promise<T> {
    const ctx = getWorkflowContext();
    if (!ctx) {
      // Not in workflow - just execute
      return await fn();
    }

    const storage = getStorage();
    const sideEffectId = WorkflowStub._generateSideEffectId();
    const history = ctx.history || await storage.readHistory(ctx.workflowId);

    // Check if side effect already executed (replay)
    if (history) {
      const existingEffect = history.events.find(
        (e) => e.type === 'sideEffect' && e.id === sideEffectId
      );
      if (existingEffect && existingEffect.type === 'sideEffect') {
        return existingEffect.value as T;
      }
    }

    // Execute side effect
    const result = await fn();

    // Record result
    await storage.appendEvent(ctx.workflowId, {
      type: 'sideEffect',
      id: sideEffectId,
      ts: Date.now(),
      value: result,
    });

    return result;
  }

  /**
   * Execute child workflow
   */
  static async child<TResult = any>(
    workflowClassOrName: (new () => Workflow<any, any>) | string,
    ...args: any[]
  ): Promise<TResult> {
    const ctx = getWorkflowContext();
    if (!ctx) {
      throw new Error('child workflows can only be called from within a workflow');
    }

    const storage = getStorage();
    const queues = getQueues();
    const childId = WorkflowStub._generateChildWorkflowId();
    const history = ctx.history || await storage.readHistory(ctx.workflowId);

    // Check if child already completed (replay)
    if (history) {
      const existingChild = history.events.find(
        (e) => e.type === 'child' && e.id === childId
      );
      if (existingChild && existingChild.type === 'child') {
        if (existingChild.error) {
          throw new Error(existingChild.error.message || 'Child workflow failed');
        }
        return existingChild.result as TResult;
      }
    }

    // Determine workflow name
    let workflowName: string;
    if (typeof workflowClassOrName === 'string') {
      workflowName = workflowClassOrName;
    } else {
      workflowName = workflowClassOrName.name;
    }

    // Create and start child workflow
    const childRecord: WorkflowRecord = {
      id: childId,
      class: workflowName,
      status: 'pending',
      args,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await storage.writeRecord(childRecord);
    await storage.writeHistory(childId, { events: [], cursor: 0 });
    await storage.addChild(ctx.workflowId, childId);

    // Queue child workflow
    await queues.workflow.add('start', {
      workflowId: childId,
      workflowName,
      args,
      isResume: false,
    });

    // Wait for child to complete
    throw new WorkflowWaitError(`Waiting for child workflow ${childId}`);
  }

  /**
   * Get workflow execution context (internal use)
   */
  static _getContext(): WorkflowExecutionContext | null {
    return getWorkflowContext() || null;
  }

  /**
   * Generate a deterministic ID for a side effect
   */
  static _generateSideEffectId(): string {
    const ctx = getWorkflowContext();
    if (!ctx) {
      return generateSideEffectId();
    }

    const id = `se-${ctx.sideEffectCursor}`;
    ctx.sideEffectCursor++;
    return id;
  }

  /**
   * Generate a deterministic ID for a child workflow
   */
  static _generateChildWorkflowId(): string {
    const ctx = getWorkflowContext();
    if (!ctx) {
      return generateWorkflowId();
    }

    const id = `child-${ctx.childWorkflowCursor}`;
    ctx.childWorkflowCursor++;
    return id;
  }

  /**
   * Generate a deterministic ID for an activity
   */
  static _generateActivityId(): string {
    const ctx = getWorkflowContext();
    if (!ctx) {
      return generateActivityId();
    }
    
    const id = `act-${ctx.activityCursor}`;
    ctx.activityCursor++;
    return id;
  }

  /**
   * Generate a deterministic ID for a timer
   */
  static _generateTimerId(): string {
    const ctx = getWorkflowContext();
    if (!ctx) {
      return generateTimerId();
    }
    
    const id = `timer-${ctx.timerCursor}`;
    ctx.timerCursor++;
    return id;
  }

  /**
   * Run code in workflow context (internal use by workers)
   */
  static _run<T>(ctx: WorkflowExecutionContext, fn: () => T): T {
    return runInWorkflowContext(ctx, fn);
  }
}
