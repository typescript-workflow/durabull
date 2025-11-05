/**
 * Non-retryable error - stops activity retries immediately
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}
