/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * WorkflowStub - interface for controlling and executing workflows
 */

import { Workflow } from './Workflow';
import { getSignalMethods, getQueryMethods } from './decorators';
import { getStorage } from './runtime/storage';
import { getQueues } from './queues';
import { generateWorkflowId, generateTimerId, generateSideEffectId } from './runtime/ids';
import { WorkflowRecord, WorkflowStatus } from './runtime/history';

export { WorkflowStatus } from './runtime/history';

// Keep in-memory polling snappy so tests and local runs complete quickly.
const WAIT_POLL_INTERVAL_MS = 10;

const CONTINUE_AS_NEW_SYMBOL = Symbol('WorkflowContinueAsNew');

interface ContinueAsNewRequest {
  [CONTINUE_AS_NEW_SYMBOL]: true;
  args: any[];
}

const getVirtualTimestamp = (workflowId?: string): number => {
  try {
    const testKitModule = require('./test/TestKit') as typeof import('./test/TestKit');
    const date = testKitModule.TestKit.now(workflowId);
    const ts = date.getTime();
    if (!Number.isNaN(ts)) {
      return ts;
    }
  } catch (_error) {
    // TestKit is optional at runtime; fall back to real time when unavailable
  }

  return Date.now();
};

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return Boolean(value) && typeof (value as any).then === 'function';
}

function isContinueAsNewRequest(value: unknown): value is ContinueAsNewRequest {
  return Boolean(value && (value as any)[CONTINUE_AS_NEW_SYMBOL]);
}

interface WorkflowExecutionContext {
  workflowId: string;
  workflow: Workflow<any, any>;
  record: WorkflowRecord;
  isResume: boolean;
  clockCursor: number;
}

export class WorkflowWaitError extends Error {
  constructor(public readonly workflowId: string) {
    super('Workflow waiting');
    this.name = 'WorkflowWaitError';
  }
}

export class WorkflowContinueAsNewError extends Error {
  constructor(public readonly workflowId: string) {
    super('Workflow continued as new');
    this.name = 'WorkflowContinueAsNewError';
  }
}

/**
 * Handle for an executing workflow
 */
export class WorkflowHandle<T extends Workflow<any, any> = Workflow<any, any>> {
  private _id: string;
  private _status: WorkflowStatus = 'created';
  private _output: any = undefined;
  private _error: Error | undefined;
  private workflow: T;
  private generator: AsyncGenerator<any, any, any> | null = null;

  constructor(workflow: T, id?: string) {
    this.workflow = workflow;
    this._id = id || generateWorkflowId();
  }

  id(): string {
    return this._id;
  }

  async start(...args: any[]): Promise<void> {
    if (this._status !== 'created') {
      throw new Error(`Workflow ${this._id} already started`);
    }

    const { Durabull } = require('./config/global');
    const isDurable = Durabull.isConfigured() && !Durabull.getConfig().testMode;

    if (isDurable) {
      const storage = getStorage();
      const queues = getQueues();

      const record: WorkflowRecord = {
        id: this._id,
        class: this.workflow.constructor.name,
        status: 'pending',
        args,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      
      await storage.writeRecord(record);
      await storage.writeHistory(this._id, { events: [], cursor: 0 });

      await queues.workflow.add('start', {
        workflowId: this._id,
        args,
        isResume: false,
      });

      this._status = 'pending';
    } else {
      this._status = 'running';
      
      try {
        this.generator = this.workflow.execute(...args);
        
        let result = await this.generator.next();
        
        while (!result.done) {
          if (isPromiseLike(result.value)) {
            const resolved = await result.value;

            if (isContinueAsNewRequest(resolved)) {
              this._restart(resolved.args);
              if (!this.generator) {
                throw new Error('Workflow generator missing after continue-as-new');
              }
              result = await this.generator.next();
              continue;
            }

            if (!this.generator) {
              throw new Error('Workflow generator missing during execution');
            }
            result = await this.generator.next(resolved);
            continue;
          }

          if (isContinueAsNewRequest(result.value)) {
            this._restart(result.value.args);
            if (!this.generator) {
              throw new Error('Workflow generator missing after continue-as-new');
            }
            result = await this.generator.next();
            continue;
          }

          if (!this.generator) {
            throw new Error('Workflow generator missing during execution');
          }
          result = await this.generator.next(result.value);
        }
        
        this._output = result.value;
        this._status = 'completed';
      } catch (error) {
        this._error = error as Error;
        this._status = 'failed';
        throw error;
      }
    }
  }

  async resume(): Promise<void> {
    const { Durabull } = require('./config/global');
    const isDurable = Durabull.isConfigured() && !Durabull.getConfig().testMode;

    if (isDurable) {
      const queues = getQueues();
      const storage = getStorage();
      const record = await storage.readRecord(this._id);
      await queues.workflow.add('resume', {
        workflowId: this._id,
        args: record?.args ?? [],
        isResume: true,
      });
    } else {
      if (!this.generator) {
        throw new Error('Workflow not started');
      }

      if (this._status === 'completed' || this._status === 'failed') {
        return;
      }

      this._status = 'running';

      try {
        let result = await this.generator.next();
        
        while (!result.done) {
          if (isPromiseLike(result.value)) {
            const resolved = await result.value;

            if (isContinueAsNewRequest(resolved)) {
              this._restart(resolved.args);
              if (!this.generator) {
                throw new Error('Workflow generator missing after continue-as-new');
              }
              result = await this.generator.next();
              continue;
            }

            result = await this.generator.next(resolved);
            continue;
          }

          if (isContinueAsNewRequest(result.value)) {
            this._restart(result.value.args);
            if (!this.generator) {
              throw new Error('Workflow generator missing after continue-as-new');
            }
            result = await this.generator.next();
            continue;
          }

          result = await this.generator.next(result.value);
        }
        
        this._output = result.value;
        this._status = 'completed';
      } catch (error) {
        this._error = error as Error;
        this._status = 'failed';
        throw error;
      }
    }
  }

  async running(): Promise<boolean> {
    const { Durabull } = require('./config/global');
    const isDurable = Durabull.isConfigured() && !Durabull.getConfig().testMode;

    if (isDurable) {
      const storage = getStorage();
      const record = await storage.readRecord(this._id);
      if (!record) return false;
      this._status = record.status;
    }
    
    return this._status === 'running' || this._status === 'waiting' || this._status === 'pending';
  }

  async status(): Promise<WorkflowStatus> {
    const { Durabull } = require('./config/global');
    const isDurable = Durabull.isConfigured() && !Durabull.getConfig().testMode;

    if (isDurable) {
      const storage = getStorage();
      const record = await storage.readRecord(this._id);
      if (!record) {
        throw new Error(`Workflow ${this._id} not found`);
      }
      this._status = record.status;
    }
    
    return this._status;
  }

  async output<TResult = any>(): Promise<TResult> {
    const { Durabull } = require('./config/global');
    const isDurable = Durabull.isConfigured() && !Durabull.getConfig().testMode;

    if (isDurable) {
      const storage = getStorage();
      const record = await storage.readRecord(this._id);
      if (!record) {
        throw new Error(`Workflow ${this._id} not found`);
      }
      
      this._status = record.status;
      
      if (this._status === 'failed') {
  const message = record.error?.message ?? 'Workflow failed';
  this._error = new Error(message);
        throw this._error;
      }
      
      if (this._status !== 'completed') {
        throw new Error('Workflow not completed yet');
      }
      
      this._output = record.output;
    } else {
      if (this._status === 'failed') {
        throw this._error;
      }
      
      if (this._status !== 'completed') {
        throw new Error('Workflow not completed yet');
      }
    }
    
    return this._output;
  }

  _getWorkflow(): T {
    return this.workflow;
  }

  private _restart(args: any[]): void {
    const WorkflowClass = this.workflow.constructor as new () => T;
    this.workflow = new WorkflowClass();
    this.generator = this.workflow.execute(...args);
    this._error = undefined;
  }
}

function createWorkflowProxy<T extends Workflow<any, any>>(handle: WorkflowHandle<T>): any {
  const workflow = handle._getWorkflow();
  const signalMethods = getSignalMethods(workflow.constructor);
  const queryMethods = getQueryMethods(workflow.constructor);

  return new Proxy(handle, {
    get(target, prop) {
      if (prop in target) {
        return (target as any)[prop];
      }

      const propStr = prop.toString();

      if (signalMethods.includes(propStr)) {
        return async (...args: any[]) => {
          const currentWorkflow = target._getWorkflow();
          (currentWorkflow as any)[propStr](...args);
          
          const { Durabull } = require('./config/global');
          const isDurable = Durabull.isConfigured() && !Durabull.getConfig().testMode;
          if (isDurable) {
            await WorkflowStub.sendSignal(target.id(), propStr, args);
          }
        };
      }

      if (queryMethods.includes(propStr)) {
        return (...args: any[]) => {
          const currentWorkflow = target._getWorkflow();
          return (currentWorkflow as any)[propStr](...args);
        };
      }

      return undefined;
    },
  });
}

export class WorkflowStub {
  private static _context: WorkflowExecutionContext | null = null;

  static _setContext(context: WorkflowExecutionContext | null) {
    if (context) {
      WorkflowStub._context = {
        ...context,
        clockCursor: context.clockCursor ?? 0,
      };
      return;
    }

    WorkflowStub._context = null;
  }

  static _getContext(): WorkflowExecutionContext | null {
    return WorkflowStub._context;
  }

  static async make<T extends Workflow<any, any>>(
    WorkflowClass: new () => T,
    id?: string
  ): Promise<WorkflowHandle<T> & T> {
    const workflow = new WorkflowClass();
    const handle = new WorkflowHandle(workflow, id);
    return createWorkflowProxy(handle) as WorkflowHandle<T> & T;
  }

  static async load<T extends Workflow<any, any>>(
    id: string,
    WorkflowClass?: new () => T
  ): Promise<WorkflowHandle<T> & T> {
    const storage = getStorage();
    const record = await storage.readRecord(id);
    
    if (!record) {
      throw new Error(`Workflow ${id} not found`);
    }

    if (!WorkflowClass) {
      throw new Error('WorkflowClass must be provided for load (registry not yet implemented)');
    }

    const workflow = new WorkflowClass();
    const handle = new WorkflowHandle(workflow, id);
    handle['_status'] = record.status;
    handle['_output'] = record.output;
    if (record.error) {
  handle['_error'] = new Error(record.error?.message ?? 'Workflow failed');
    }
    
    return createWorkflowProxy(handle) as WorkflowHandle<T> & T;
  }

  static async timer(secondsOrString: number | string): Promise<void> {
    const seconds = typeof secondsOrString === 'string' 
      ? parseInt(secondsOrString, 10) 
      : secondsOrString;
    
    const context = WorkflowStub._getContext();
    if (!context) {
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      return;
    }

    const waiting = context.record.waiting;
    if (waiting && waiting.type === 'await' && Date.now() >= waiting.resumeAt) {
      context.record.waiting = undefined;
      return;
    }

    const delayMs = Math.max(0, seconds * 1000);
    if (delayMs === 0) {
      return;
    }

    await WorkflowStub._scheduleWait({
      type: 'await',
      delayMs,
    });
    return;
  }

  private static async _scheduleWait(wait: { type: 'await' | 'awaitWithTimeout'; delayMs: number; deadline?: number }): Promise<never> {
    const context = WorkflowStub._getContext();
    if (!context) {
      throw new Error('Cannot schedule workflow wait without active execution context');
    }

    const storage = getStorage();
    const queues = getQueues();
    const record = (await storage.readRecord(context.workflowId)) || context.record;
    if (!record) {
      throw new Error(`Workflow ${context.workflowId} not found while scheduling wait`);
    }

    const now = Date.now();
    record.status = 'waiting';
    record.updatedAt = now;
    record.waiting = {
      type: wait.type,
      resumeAt: now + wait.delayMs,
      deadline: wait.deadline,
    };

    await storage.writeRecord(record);
    context.record = record;

    await queues.workflow.add(
      'resume',
      {
        workflowId: context.workflowId,
        args: record.args ?? [],
        isResume: true,
      },
      {
        delay: wait.delayMs,
      }
    );

    throw new WorkflowWaitError(context.workflowId);
  }

  static async await(predicate: () => boolean): Promise<void> {
    if (predicate()) {
      const context = WorkflowStub._getContext();
      if (context) {
        context.record.waiting = undefined;
      }
      return;
    }

    const context = WorkflowStub._getContext();
    if (!context) {
      while (!predicate()) {
        await new Promise(resolve => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
      }
      return;
    }

    await WorkflowStub._scheduleWait({
      type: 'await',
      delayMs: WAIT_POLL_INTERVAL_MS,
    });
    return;
  }

  static async awaitWithTimeout(
    secondsOrString: number | string,
    predicate: () => boolean
  ): Promise<boolean> {
    const seconds = typeof secondsOrString === 'string'
      ? parseInt(secondsOrString, 10)
      : secondsOrString;
    
    if (predicate()) {
      const context = WorkflowStub._getContext();
      if (context) {
        context.record.waiting = undefined;
      }
      return true;
    }

    const context = WorkflowStub._getContext();
    if (!context) {
      const timeoutMs = seconds * 1000;
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start >= timeoutMs) {
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
      }
      return true;
    }

    const now = Date.now();
    const existingDeadline = context.record.waiting?.type === 'awaitWithTimeout'
      ? context.record.waiting.deadline
      : undefined;
    const deadline = existingDeadline ?? now + seconds * 1000;

    if (now >= deadline) {
      context.record.waiting = undefined;
      return false;
    }

    const delayMs = Math.min(WAIT_POLL_INTERVAL_MS, Math.max(0, deadline - now));

    await WorkflowStub._scheduleWait({
      type: 'awaitWithTimeout',
      delayMs,
      deadline,
    });

    return false;
  }

  static async sideEffect<T>(fn: () => T | Promise<T>): Promise<T> {
    return await fn();
  }

  static async now(): Promise<Date> {
    const context = WorkflowStub._getContext();
    const timestamp = getVirtualTimestamp(context?.workflowId);

    if (!context) {
      return new Date(timestamp);
    }

    const cursor = context.clockCursor ?? 0;
    const existing = context.record.clockEvents?.[cursor];

    if (typeof existing === 'number' && !Number.isNaN(existing)) {
      context.clockCursor = cursor + 1;
      return new Date(existing);
    }

    const record = context.record;
    if (!record.clockEvents) {
      record.clockEvents = [];
    }
    record.clockEvents[cursor] = timestamp;
    context.clockCursor = cursor + 1;

    record.updatedAt = Date.now();
    const storage = getStorage();
    await storage.writeRecord(record);

    return new Date(timestamp);
  }

  static async continueAsNew(..._args: any[]): Promise<any> {
    const args = Array.from(_args);
    const request: ContinueAsNewRequest = {
      [CONTINUE_AS_NEW_SYMBOL]: true,
      args,
    };

    const context = WorkflowStub._getContext();
    if (!context) {
      return request;
    }

    const storage = getStorage();
    const queues = getQueues();

    const existingRecord = (await storage.readRecord(context.workflowId)) ?? context.record;
    if (!existingRecord) {
      throw new Error(`Workflow ${context.workflowId} not found for continue-as-new`);
    }

    const newWorkflowId = generateWorkflowId();
    const now = Date.now();

    const newRecord: WorkflowRecord = {
      id: newWorkflowId,
      class: existingRecord.class,
      status: 'pending',
      args,
      createdAt: now,
      updatedAt: now,
      continuedFrom: existingRecord.id,
    };

    await storage.writeRecord(newRecord);
    await storage.writeHistory(newWorkflowId, { events: [], cursor: 0 });

    existingRecord.status = 'continued';
    existingRecord.continuedTo = newWorkflowId;
    existingRecord.waiting = undefined;
    existingRecord.updatedAt = now;
    await storage.writeRecord(existingRecord);
    context.record = existingRecord;

    await queues.workflow.add('start', {
      workflowId: newWorkflowId,
      args,
      isResume: false,
    });

    throw new WorkflowContinueAsNewError(newWorkflowId);
  }

  static async child<TChild extends Workflow<any, any>>(
    WorkflowClass: new () => TChild,
    ...args: any[]
  ): Promise<ChildWorkflowPromise<TChild>> {
    const handle = await ChildWorkflowStub.make(WorkflowClass);
    await handle.start(...args);
    return new ChildWorkflowPromise(handle, args);
  }

  static async sendSignal(workflowId: string, name: string, payload: any[]): Promise<void> {
    const storage = getStorage();
    await storage.pushSignal(workflowId, {
      name,
      payload,
      ts: Date.now(),
    });

    const record = await storage.readRecord(workflowId);
    if (record) {
      record.status = 'pending';
      record.updatedAt = Date.now();
      await storage.writeRecord(record);
    }

    const queues = getQueues();
    await queues.workflow.add('resume', {
      workflowId,
      args: record?.args ?? [],
      isResume: true,
    });
  }

  static generateTimerId(): string {
    return generateTimerId();
  }

  static generateSideEffectId(): string {
    return generateSideEffectId();
  }
}

export class ChildWorkflowPromise<TChild extends Workflow<any, any>> implements PromiseLike<any> {
  constructor(
    private handle: WorkflowHandle<TChild>,
    private args: any[]
  ) {}

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.handle.output().then(onfulfilled, onrejected);
  }

  async start(): Promise<void> {
    await this.handle.start(...this.args);
  }

  async output<TResult = any>(): Promise<TResult> {
    return await this.handle.output<TResult>();
  }
}

export class ChildWorkflowStub {
  static async make<T extends Workflow<any, any>>(
    WorkflowClass: new () => T,
    id?: string
  ): Promise<WorkflowHandle<T> & T> {
    return WorkflowStub.make(WorkflowClass, id);
  }
}
