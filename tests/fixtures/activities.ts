/**
 * Shared activity fixtures adapted from the Laravel workflow test suite.
 */

import { Activity, NonRetryableError } from '../../src';

export class TestActivity extends Activity<[], string> {
  async execute(): Promise<string> {
    return 'activity';
  }
}

export class TestOtherActivity extends Activity<[string], string> {
  async execute(value: string): Promise<string> {
    return value;
  }
}

export class TestCountActivity extends Activity<[number], number> {
  async execute(count: number): Promise<number> {
    return count;
  }
}

export class TestExceptionActivity extends Activity<[], string> {
  private attempts = 0;

  async execute(): Promise<string> {
    this.attempts += 1;

    if (this.attempts === 1) {
      throw new Error('failed');
    }

    return 'activity';
  }

  backoff(): number[] {
    return [0];
  }
}

export class TestSingleTryExceptionActivity extends Activity<[boolean], string> {
  tries = 1;

  async execute(shouldThrow: boolean): Promise<string> {
    if (shouldThrow) {
      throw new Error('failed');
    }

    return 'activity';
  }
}

export class TestRetriesActivity extends Activity<[], never> {
  tries = 3;

  async execute(): Promise<never> {
    throw new Error('failed');
  }

  backoff(): number[] {
    return [0, 0, 0];
  }
}

export class TestSagaActivity extends Activity<[], never> {
  tries = 1;

  async execute(): Promise<never> {
    throw new Error('saga');
  }
}

export class TestSagaUndoActivity extends Activity<[], string> {
  async execute(): Promise<string> {
    return 'saga_undo_activity';
  }
}

export class TestUndoActivity extends Activity<[], string> {
  async execute(): Promise<string> {
    return 'undo_activity';
  }
}

export class TestTimeoutActivity extends Activity<[], never> {
  timeout = 0.05;
  tries = 1;

  async execute(): Promise<never> {
    // Never resolve so the timeout fires.
    return await new Promise<never>(() => {
      /* intentionally empty */
    });
  }
}

export class TestHeartbeatActivity extends Activity<[], string> {
  timeout = 1;

  async execute(): Promise<string> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.heartbeat();
    }

    return 'activity';
  }
}

export class TestNonRetryableExceptionActivity extends Activity<[], never> {
  async execute(): Promise<never> {
    throw new NonRetryableError('This is a non-retryable error');
  }
}

export interface TestUser {
  id: number;
}

export class TestModelActivity extends Activity<[TestUser], number> {
  async execute(user: TestUser): Promise<number> {
    return user.id;
  }
}

export class TestInvalidActivity extends Activity<[], never> {
  async execute(): Promise<never> {
    throw new Error('execute() must be implemented');
  }
}

export enum TestEnum {
  First = 'first',
  Second = 'second',
  Third = 'third',
}
