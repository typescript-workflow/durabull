import { AsyncLocalStorage } from 'async_hooks';
import { Workflow } from '../Workflow';
import { WorkflowRecord } from './history';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WorkflowExecutionContext {
  workflowId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflow: Workflow<any, any>;
  record: WorkflowRecord;
  isResume: boolean;
  clockCursor: number;
  timerCursor: number;
  sideEffectCursor: number;
  activityCursor: number;
}

const workflowContext = new AsyncLocalStorage<WorkflowExecutionContext>();

export function getWorkflowContext(): WorkflowExecutionContext | undefined {
  return workflowContext.getStore();
}

export function runInWorkflowContext<T>(ctx: WorkflowExecutionContext, fn: () => T): T {
  return workflowContext.run(ctx, fn);
}

export const getVirtualTimestamp = (workflowId?: string): number => {
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
