/**
 * Unit tests for Workflow base class
 */

import { Workflow } from '../../src/Workflow';

// Mock logger to prevent console noise during tests
jest.mock('../../src/runtime/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

describe('Workflow', () => {
  class TestWorkflow extends Workflow<[string], string> {
    // eslint-disable-next-line require-yield
    async *execute(input: string): AsyncGenerator<unknown, string, unknown> {
      return `Hello, ${input}!`;
    }
  }

  it('should be instantiable', () => {
    const workflow = new TestWorkflow();
    expect(workflow).toBeInstanceOf(Workflow);
  });

  it('should have execute method', () => {
    const workflow = new TestWorkflow();
    expect(typeof workflow.execute).toBe('function');
  });

  it('should support compensation', async () => {
    const compensations: string[] = [];

    class CompensatingWorkflow extends Workflow<[], string> {
      async *execute(): AsyncGenerator<unknown, string, unknown> {
        this.addCompensation(() => {
          compensations.push('comp1');
        });
        this.addCompensation(() => {
          compensations.push('comp2');
        });

        yield* this.compensate();
        
        return 'done';
      }
    }

    const workflow = new CompensatingWorkflow();
    const gen = workflow.execute();
    
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    expect(compensations).toEqual(['comp2', 'comp1']);
  });

  it('should support parallel compensation', async () => {
    const compensations: string[] = [];

    class ParallelCompWorkflow extends Workflow<[], string> {
      async *execute(): AsyncGenerator<unknown, string, unknown> {
        this.setParallelCompensation(true);
        
        this.addCompensation(async () => {
          compensations.push('comp1');
        });
        this.addCompensation(async () => {
          compensations.push('comp2');
        });

        yield* this.compensate();
        
        return 'done';
      }
    }

    const workflow = new ParallelCompWorkflow();
    const gen = workflow.execute();
    
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    expect(compensations).toContain('comp1');
    expect(compensations).toContain('comp2');
    expect(compensations).toHaveLength(2);
  });

  it('should support continue with error', async () => {
    const compensations: string[] = [];
    let errorThrown = false;

    class ErrorHandlingWorkflow extends Workflow<[], string> {
      async *execute(): AsyncGenerator<unknown, string, unknown> {
        this.setContinueWithError(true);
        
        this.addCompensation(() => {
          compensations.push('comp1');
        });
        this.addCompensation(() => {
          compensations.push('comp2');
          throw new Error('Compensation failed');
        });
        this.addCompensation(() => {
          compensations.push('comp3');
        });

        try {
          yield* this.compensate();
        } catch (error) {
          errorThrown = true;
        }
        
        return 'done';
      }
    }

    const workflow = new ErrorHandlingWorkflow();
    const gen = workflow.execute();
    
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    expect(errorThrown).toBe(false);
    expect(compensations).toContain('comp1');
    expect(compensations).toContain('comp2');
    expect(compensations).toContain('comp3');
  });

  it('should return correct result', async () => {
    const workflow = new TestWorkflow();
    const gen = workflow.execute('World');
    const result = await gen.next();
    
    expect(result.done).toBe(true);
    expect(result.value).toBe('Hello, World!');
  });

  it('should support async generator iteration', async () => {
    class MultiStepWorkflow extends Workflow<[], number> {
      async *execute(): AsyncGenerator<unknown, number, unknown> {
        yield 1;
        yield 2;
        yield 3;
        return 42;
      }
    }

    const workflow = new MultiStepWorkflow();
    const gen = workflow.execute();
    
    const values: unknown[] = [];
    let result = await gen.next();
    
    while (!result.done) {
      values.push(result.value);
      result = await gen.next();
    }

    expect(values).toEqual([1, 2, 3]);
    expect(result.value).toBe(42);
  });
});
