/**
 * Lightweight state machine helper.
 */

export class StateMachine {
  private states: string[] = [];
  private transitions: Record<string, { from: string; to: string }> = {};
  private currentState?: string;

  addState(state: string): void {
    this.states.push(state);
  }

  addTransition(action: string, fromState: string, toState: string): void {
    this.transitions[action] = {
      from: fromState,
      to: toState,
    };
  }

  initialize(): void {
    if (this.states.length > 0) {
      this.currentState = this.states[0];
    }
  }

  getCurrentState(): string | undefined {
    return this.currentState;
  }

  apply(action: string): void {
    const transition = this.transitions[action];
    if (transition && transition.from === this.currentState) {
      this.currentState = transition.to;
    } else {
      throw new Error('Transition not found.');
    }
  }
}
