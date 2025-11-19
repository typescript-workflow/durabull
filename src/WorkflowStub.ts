/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * WorkflowStub - interface for controlling and executing workflows (Durable Mode Only)
 */

import { Workflow } from './Workflow';
import { getQueryMethods } from './decorators';
import { getStorage } from './runtime/storage';
import { getQueues } from './queues';
import { generateWorkflowId } from './runtime/ids';
import { WorkflowRecord, WorkflowStatus } from './runtime/history';

export { WorkflowStatus } from './runtime/history';

/**
 * Error thrown when workflow needs to wait for external events
 */
export class WorkflowWaitError extends Error {
  constructor(message: string = 'Workflow waiting') {
    super(message);
    this.name = 'WorkflowWaitError';
  }
}

/**
 * Error thrown when workflow continues as new
 */
export class WorkflowContinueAsNewError extends Error {
  constructor(public workflowId: string) {
    super(`Workflow continued as new: ${workflowId}`);
    this.name = 'WorkflowContinueAsNewError';
  }
}

import { AsyncLocalStorage } from 'async_hooks';

const getVirtualTimestamp = (workflowId?: string): number => {
  const ctx = workflowContext.getStore();
  if (!ctx || !workflowId) {
    return Date.now();
  }
  
  // Use clock cursor for deterministic replay
  const cursor = ctx.clockCursor ?? 0;
  const existing = ctx.record.clockEvents?.[cursor];
  
  if (typeof existing === 'number' && !Number.isNaN(existing)) {
    ctx.clockCursor = cursor + 1;
    return existing;
  }
  
  // First execution - record timestamp
  const timestamp = Date.now();
  if (!ctx.record.clockEvents) {
    ctx.record.clockEvents = [];
  }
  ctx.record.clockEvents[cursor] = timestamp;
  ctx.clockCursor = cursor + 1;
  
  return timestamp;
};

interface WorkflowExecutionContext {
  workflowId: string;
  workflow: Workflow<any, any>;
  record: WorkflowRecord;
  isResume: boolean;
  clockCursor: number;
  timerCursor: number;
  sideEffectCursor: number;
  activityCursor: number;
}

const workflowContext = new AsyncLocalStorage<WorkflowExecutionContext>();

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
    const { Durabull } = require('./config/global');
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
        console.error('Workflow onStart hook failed', error);
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
        const { replayWorkflow } = require('./runtime/replayer');
        
        try {
          // Replay workflow to get current state
          const { workflow } = await replayWorkflow(this.workflowId, WorkflowClass);
          
          // Execute query on the replayed instance
          return (workflow as any)[methodName](...args);
        } catch (error) {
          console.error('Query execution failed', error);
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
    const { Durabull } = require('./config/global');
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
    const ctx = workflowContext.getStore();
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
    
    const ctx = workflowContext.getStore();
    if (!ctx) {
      // Not in workflow context - just sleep
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      return;
    }

    const { getStorage } = require('./runtime/storage');
    const { getQueues } = require('./queues');
    
    const storage = getStorage();
    const queues = getQueues();
    const timerId = WorkflowStub._generateTimerId();
    const history = await storage.readHistory(ctx.workflowId);

    // Check if timer already fired (replay)
    if (history) {
      const firedEvent = history.events.find(
        (e: any) => e.type === 'timer-fired' && e.id === timerId
      );
      if (firedEvent) {
        return; // Timer completed
      }
    }

    // Check if timer started but not fired
    const startedEvent = history?.events.find(
      (e: any) => e.type === 'timer-started' && e.id === timerId
    );

    if (!startedEvent) {
      // Record timer start
      await storage.appendEvent(ctx.workflowId, {
        type: 'timer-started',
        id: timerId,
        ts: Date.now(),
        delay: seconds,
      });
      
      // Update workflow to waiting status
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

      // Schedule resume job
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

    // Suspend execution
    throw new WorkflowWaitError(`Timer ${timerId} waiting ${seconds}s`);
  }

  /**
   * Wait for a condition to become true
   */
  static async await(predicate: () => boolean): Promise<void> {
    if (predicate()) {
      return;
    }

    const ctx = workflowContext.getStore();
    if (!ctx) {
      // Not in workflow context - poll
      while (!predicate()) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    const { getStorage } = require('./runtime/storage');
    const { getQueues } = require('./queues');
    
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

    const ctx = workflowContext.getStore();
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

    const { getStorage } = require('./runtime/storage');
    const { getQueues } = require('./queues');
    
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
    const ctx = workflowContext.getStore();
    if (!ctx) {
      throw new Error('continueAsNew can only be called from within a workflow');
    }

    const { getStorage } = require('./runtime/storage');
    const { getQueues } = require('./queues');
    const { generateWorkflowId } = require('./runtime/ids');
    
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
    const ctx = workflowContext.getStore();
    if (!ctx) {
      // Not in workflow - just execute
      return await fn();
    }

    const { getStorage } = require('./runtime/storage');
    const { generateSideEffectId } = require('./runtime/ids');
    
    const storage = getStorage();
    const sideEffectId = generateSideEffectId();
    const history = await storage.readHistory(ctx.workflowId);

    // Check if side effect already executed (replay)
    if (history) {
      const existingEffect = history.events.find(
        (e: any) => e.type === 'sideEffect' && e.id === sideEffectId
      );
      if (existingEffect) {
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
    const ctx = workflowContext.getStore();
    if (!ctx) {
      throw new Error('child workflows can only be called from within a workflow');
    }

    const { getStorage } = require('./runtime/storage');
    const { getQueues } = require('./queues');
    const { generateWorkflowId } = require('./runtime/ids');
    
    const storage = getStorage();
    const queues = getQueues();
    const childId = generateWorkflowId();
    const history = await storage.readHistory(ctx.workflowId);

    // Check if child already completed (replay)
    if (history) {
      const existingChild = history.events.find(
        (e: any) => e.type === 'child' && e.id === childId
      );
      if (existingChild) {
        if ('error' in existingChild && existingChild.error) {
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
   * Set workflow execution context (internal use by workers)
   * @deprecated Use _run instead
   */
  static _setContext(_ctx: WorkflowExecutionContext | null): void {
    // This is now handled by AsyncLocalStorage in _run
  }

  /**
   * Get workflow execution context (internal use)
   */
  static _getContext(): WorkflowExecutionContext | null {
    return workflowContext.getStore() || null;
  }

  /**
   * Generate a deterministic ID for an activity
   */
  static _generateActivityId(): string {
    const ctx = workflowContext.getStore();
    if (!ctx) {
      const { generateActivityId } = require('./runtime/ids');
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
    const ctx = workflowContext.getStore();
    if (!ctx) {
      const { generateTimerId } = require('./runtime/ids');
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
    return workflowContext.run(ctx, fn);
  }
}
