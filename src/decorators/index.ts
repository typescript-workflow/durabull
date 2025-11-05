/**
 * Decorators for workflow methods
 */

export const SIGNAL_METHODS = Symbol('durabull:signalMethods');
export const QUERY_METHODS = Symbol('durabull:queryMethods');

/**
 * Mark a workflow method as a signal (can mutate state, advances replay)
 */
type WorkflowMetadataStore = Record<PropertyKey, unknown> & {
  [SIGNAL_METHODS]?: string[];
  [QUERY_METHODS]?: string[];
};

type WorkflowInitializerTarget = { constructor: WorkflowMetadataStore };

type WorkflowMethod = (this: unknown, ...args: unknown[]) => unknown;

const ensureMetadata = (
  ctor: WorkflowMetadataStore,
  key: typeof SIGNAL_METHODS | typeof QUERY_METHODS
): string[] => {
  if (!ctor[key]) {
    ctor[key] = [];
  }
  return ctor[key] as string[];
};

export function SignalMethod() {
  return function signalDecorator(
    targetOrValue: unknown,
    propertyKeyOrContext: string | symbol | ClassMethodDecoratorContext<unknown, WorkflowMethod>
  ): PropertyDescriptor | void {
    if (typeof propertyKeyOrContext === 'string' || typeof propertyKeyOrContext === 'symbol') {
      const target = targetOrValue as WorkflowInitializerTarget;
      const ctor = target.constructor;
      ensureMetadata(ctor, SIGNAL_METHODS).push(propertyKeyOrContext.toString());
      return;
    }

    const context = propertyKeyOrContext as ClassMethodDecoratorContext<WorkflowInitializerTarget, WorkflowMethod>;
    if (!context || context.kind !== 'method') {
      return;
    }

    context.addInitializer(function (this: WorkflowInitializerTarget) {
      const ctor = this.constructor;
      ensureMetadata(ctor, SIGNAL_METHODS).push(String(context.name));
    });
  };
}

/**
 * Mark a workflow method as a query (read-only, does not advance replay)
 */
export function QueryMethod() {
  return function queryDecorator(
    targetOrValue: unknown,
    propertyKeyOrContext: string | symbol | ClassMethodDecoratorContext<unknown, WorkflowMethod>
  ): PropertyDescriptor | void {
    if (typeof propertyKeyOrContext === 'string' || typeof propertyKeyOrContext === 'symbol') {
      const target = targetOrValue as WorkflowInitializerTarget;
      const ctor = target.constructor;
      ensureMetadata(ctor, QUERY_METHODS).push(propertyKeyOrContext.toString());
      return;
    }

    const context = propertyKeyOrContext as ClassMethodDecoratorContext<WorkflowInitializerTarget, WorkflowMethod>;
    if (!context || context.kind !== 'method') {
      return;
    }

    context.addInitializer(function (this: WorkflowInitializerTarget) {
      const ctor = this.constructor;
      ensureMetadata(ctor, QUERY_METHODS).push(String(context.name));
    });
  };
}

/**
 * Get signal methods for a workflow class
 */
export function getSignalMethods(workflowClass: unknown): string[] {
  if (typeof workflowClass !== 'object' && typeof workflowClass !== 'function') {
    return [];
  }

  const store = workflowClass as WorkflowMetadataStore;
  return Array.isArray(store[SIGNAL_METHODS]) ? store[SIGNAL_METHODS] : [];
}

/**
 * Get query methods for a workflow class
 */
export function getQueryMethods(workflowClass: unknown): string[] {
  if (typeof workflowClass !== 'object' && typeof workflowClass !== 'function') {
    return [];
  }

  const store = workflowClass as WorkflowMetadataStore;
  return Array.isArray(store[QUERY_METHODS]) ? store[QUERY_METHODS] : [];
}
