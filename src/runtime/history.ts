/**
 * Event store & history for deterministic replay
 */

/**
 * History event types for workflow execution
 */
export interface SerializedError {
  message?: string;
  stack?: string;
  [key: string]: unknown;
}

export type HistoryEvent =
  | { type: 'activity'; id: string; ts: number; result?: unknown; error?: SerializedError }
  | { type: 'timer'; id: string; ts: number; delay: number }
  | { type: 'signal'; id: string; ts: number; name: string; payload: unknown }
  | { type: 'child'; id: string; ts: number; childId: string; result?: unknown; error?: SerializedError }
  | { type: 'exception'; id: string; ts: number; error: SerializedError }
  | { type: 'sideEffect'; id: string; ts: number; value: unknown };

/**
 * Workflow execution status
 */
export type WorkflowStatus = 'created' | 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'continued';

/**
 * Workflow record persisted in storage
 */
export interface WorkflowRecord {
  id: string;
  class: string;
  status: WorkflowStatus;
  args?: unknown[];
  output?: unknown;
  error?: SerializedError;
  createdAt: number;
  updatedAt: number;
  continuedFrom?: string;
  continuedTo?: string;
  waiting?: {
    type: 'await' | 'awaitWithTimeout';
    resumeAt: number;
    deadline?: number;
  };
  signalCursor?: Record<string, number>;
  clockEvents?: number[];
}

/**
 * History with replay cursor
 */
export interface History {
  events: HistoryEvent[];
  cursor: number; // replay index
}
