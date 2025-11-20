export interface SerializedError {
  message?: string;
  stack?: string;
  [key: string]: unknown;
}

export type HistoryEvent =
  | { type: 'activity'; id: string; ts: number; result?: unknown; error?: SerializedError }
  | { type: 'timer'; id: string; ts: number; delay: number }
  | { type: 'timer-started'; id: string; ts: number; delay: number }
  | { type: 'timer-fired'; id: string; ts: number }
  | { type: 'signal'; id: string; ts: number; name: string; payload: unknown }
  | { type: 'child'; id: string; ts: number; childId: string; result?: unknown; error?: SerializedError }
  | { type: 'exception'; id: string; ts: number; error: SerializedError }
  | { type: 'sideEffect'; id: string; ts: number; value: unknown };

export type WorkflowStatus = 'created' | 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'continued';

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

export interface History {
  events: HistoryEvent[];
  cursor: number;
}
