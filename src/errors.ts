/**
 * Non-retryable error - stops activity retries immediately
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/**
 * Error thrown when workflow needs to wait for external events.
 * The `message` parameter should be a descriptive explanation of why the workflow is waiting,
 * e.g., "Timer 123 waiting 10s". If not provided, defaults to "Workflow waiting".
 */
export class WorkflowWaitError extends Error {
  constructor(message?: string) {
    super(message ?? 'Workflow waiting');
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
