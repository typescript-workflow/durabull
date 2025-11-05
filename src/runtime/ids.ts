/**
 * ID generation helpers using ULID
 */

import { ulid } from 'ulid';

/**
 * Generate a new workflow ID
 */
export function generateWorkflowId(): string {
  return `wf-${ulid()}`;
}

/**
 * Generate a new activity ID
 */
export function generateActivityId(): string {
  return `act-${ulid()}`;
}

/**
 * Generate a new timer ID
 */
export function generateTimerId(): string {
  return `timer-${ulid()}`;
}

/**
 * Generate a new signal ID
 */
export function generateSignalId(): string {
  return `sig-${ulid()}`;
}

/**
 * Generate a new side effect ID
 */
export function generateSideEffectId(): string {
  return `se-${ulid()}`;
}

/**
 * Generate a new child workflow ID
 */
export function generateChildWorkflowId(): string {
  return `wf-${ulid()}`;
}
