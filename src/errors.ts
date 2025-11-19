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
