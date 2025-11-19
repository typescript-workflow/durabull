/**
 * Unit tests for decorators
 */

import { SignalMethod, QueryMethod, WebhookMethod, getSignalMethods, getQueryMethods, getWebhookMethods } from '../../src/decorators';
import { Workflow } from '../../src/Workflow';

describe('Decorators', () => {
  describe('@SignalMethod', () => {
    class TestWorkflow extends Workflow<[], void> {
      private value = 0;

      @SignalMethod()
      increment() {
        this.value++;
      }

      @SignalMethod()
      add(n: number) {
        this.value += n;
      }

      getValue() {
        return this.value;
      }

      async *execute(): AsyncGenerator<any, void, any> {
      }
    }

    it('should mark methods as signals', () => {
      const signals = getSignalMethods(TestWorkflow);
      expect(signals).toContain('increment');
      expect(signals).toContain('add');
      expect(signals).not.toContain('getValue');
    });

    it('should allow signal methods to be called', () => {
      const workflow = new TestWorkflow();
      workflow.increment();
      expect(workflow.getValue()).toBe(1);
      workflow.add(5);
      expect(workflow.getValue()).toBe(6);
    });
  });

  describe('@QueryMethod', () => {
    class TestWorkflow extends Workflow<[], void> {
      private value = 42;

      @QueryMethod()
      getValue(): number {
        return this.value;
      }

      @QueryMethod()
      getDouble(): number {
        return this.value * 2;
      }

      setValue(n: number) {
        this.value = n;
      }

      async *execute(): AsyncGenerator<any, void, any> {
      }
    }

    it('should mark methods as queries', () => {
      const queries = getQueryMethods(TestWorkflow);
      expect(queries).toContain('getValue');
      expect(queries).toContain('getDouble');
      expect(queries).not.toContain('setValue');
    });

    it('should allow query methods to be called', () => {
      const workflow = new TestWorkflow();
      expect(workflow.getValue()).toBe(42);
      expect(workflow.getDouble()).toBe(84);
    });
  });

  describe('@WebhookMethod', () => {
    class TestWorkflow extends Workflow<[], void> {
      @WebhookMethod()
      @SignalMethod()
      publicSignal() {
      }

      @SignalMethod()
      privateSignal() {
      }

      async *execute(): AsyncGenerator<any, void, any> {
      }
    }

    it('should mark methods as webhook-accessible', () => {
      const webhooks = getWebhookMethods(TestWorkflow);
      expect(webhooks).toContain('publicSignal');
      expect(webhooks).not.toContain('privateSignal');
    });
  });

  describe('Multiple decorators', () => {
    class TestWorkflow extends Workflow<[], void> {
      @WebhookMethod()
      @SignalMethod()
      publicAction() {
      }

      @QueryMethod()
      getStatus(): string {
        return 'running';
      }

      async *execute(): AsyncGenerator<any, void, any> {
      }
    }

    it('should support multiple decorators on same method', () => {
      const signals = getSignalMethods(TestWorkflow);
      const webhooks = getWebhookMethods(TestWorkflow);
      const queries = getQueryMethods(TestWorkflow);

      expect(signals).toContain('publicAction');
      expect(webhooks).toContain('publicAction');
      expect(queries).toContain('getStatus');
      expect(queries).not.toContain('publicAction');
    });
  });
});
