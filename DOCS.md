# Durabull Documentation

Durabull is a durable workflow runtime for TypeScript applications. It combines generator-based workflows, idempotent activities, and BullMQ-backed persistence to deliver replay-safe orchestrations inspired by Laravel Workflow and Temporal.

- **Language:** TypeScript (ES2020 target)
- **Queues:** BullMQ / Redis
- **Execution model:** `async *execute()` generators that `yield` durable effects
- **Persistence:** Redis-backed history/event storage (pluggable via `setStorage`)

---

## Installation

```bash
npm install durabull bullmq ioredis
# or
pnpm add durabull bullmq ioredis
```

Durabull ships as a normal npm package. BullMQ and ioredis are required runtime dependencies.

After installing, configure Durabull once at process start (worker processes, API servers, test harnesses):

```typescript
import { Durabull } from 'durabull';

const myLogger = console; // Replace with your preferred logger implementation

Durabull.configure({
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queues: {
    workflow: 'durabull:workflow',
    activity: 'durabull:activity',
  },
  serializer: 'json',          // 'json' | 'base64'
  pruneAge: '30 days',
  webhooks: {
    route: '/webhooks',
    auth: { method: 'token', header: 'Authorization', token: process.env.API_TOKEN },
  },
  logger: {
    info: (...args) => myLogger.info(...args),
    error: (...args) => myLogger.error(...args),
  },
});
```

- `redisUrl` configures both storage and BullMQ connections.
- `queues` names the workflow and activity queues. Use per-service overrides to isolate workloads.
- `serializer` controls how workflow state/history is encoded.
- `pruneAge` defines default workflow retention.
- `webhooks` enables optional HTTP control plane helpers.
- `logger` allows you to plug in your own structured logger (info/warn/error/debug).
- `testMode` (boolean) disables Redis/BullMQ for fully in-memory testing.

---

## Workflows

Workflows orchestrate activities via generator functions. Extend the `Workflow` base class and implement `async *execute(...)`:

```typescript
import { Workflow, ActivityStub, WorkflowStub } from 'durabull';
import { ChargeCard } from '../activities/ChargeCard';
import { EmailReceipt } from '../activities/EmailReceipt';

export class CheckoutWorkflow extends Workflow<[string, number], string> {
  async *execute(orderId: string, amount: number) {
    const chargeId = yield ActivityStub.make(ChargeCard, orderId, amount);
    yield ActivityStub.make(EmailReceipt, orderId, chargeId);
    return chargeId;
  }
}
```

Use `WorkflowStub` to start, resume, signal, or query a workflow:

```typescript
const checkout = await WorkflowStub.make(CheckoutWorkflow);
await checkout.start('order-123', 4999);

while (await checkout.running()) {
  await new Promise(resolve => setTimeout(resolve, 250));
}

const chargeId = await checkout.output<string>();
```

### Workflow Handles

`WorkflowStub.make()` returns a proxy that combines:

- `WorkflowHandle` methods (`start()`, `resume()`, `status()`, `running()`, `output()`, `id()`)
- The workflow instance itself (signals, queries, helpers)

Load existing workflows by id (provide the class for replay):

```typescript
const handle = await WorkflowStub.load('wf_abc123', CheckoutWorkflow);
const status = await handle.status();
```

### Signals & Queries

Annotate methods with `@SignalMethod()` or `@QueryMethod()` to expose runtime hooks:

```typescript
import { Workflow, SignalMethod, QueryMethod, WorkflowStub } from 'durabull';

export class ShipmentWorkflow extends Workflow<[string], void> {
  private delivered = false;

  @SignalMethod()
  markDelivered() {
    this.delivered = true;
  }

  @QueryMethod()
  isDelivered(): boolean {
    return this.delivered;
  }

  async *execute(orderId: string) {
    yield WorkflowStub.await(() => this.delivered);
  }
}
```

Signals mutate workflow state; queries must be side-effect free.

### Timers & Await

- `WorkflowStub.timer(seconds | string)` creates a durable sleep.
- `WorkflowStub.await(predicate)` polls deterministically until the predicate is true.
- `WorkflowStub.awaitWithTimeout(seconds | string, predicate)` races predicate evaluation against a durable timer and returns `true` if the predicate fired first.

```typescript
async *execute() {
  yield WorkflowStub.timer(300);           // 5 minute durable delay
  const ok = yield WorkflowStub.awaitWithTimeout('10 minutes', () => this.receivedSignal);
  if (!ok) {
    yield ActivityStub.make(SendReminderEmail);
  }
}
```

### Deterministic Time

Use `WorkflowStub.now()` to obtain a replay-safe clock. Durabull records the first value produced during live execution and reuses it during replays. It also cooperates with `TestKit.fakeTime()`.

```typescript
const startedAt = yield WorkflowStub.now();
yield WorkflowStub.timer(30);
const elapsedMs = (yield WorkflowStub.now()).getTime() - startedAt.getTime();
```

### Continue-As-New

Restart a workflow with fresh history using `WorkflowStub.continueAsNew(...)`:

```typescript
async *execute(count = 0, target = 5): AsyncGenerator<unknown, string, unknown> {
  yield ActivityStub.make(LogProgress, count);
  if (count >= target) {
    return 'done';
  }
  return (yield WorkflowStub.continueAsNew(count + 1, target)) as never;
}
```

The current workflow is marked as `continued`, and a new workflow id is created with the supplied arguments.

### Child Workflows

Spawn workflows from inside workflows via `ChildWorkflowStub.make()` or `WorkflowStub.child()`:

```typescript
const child = yield ChildWorkflowStub.make(FulfillmentWorkflow, orderId);
const receipt = yield child.output<string>();
```

Children run under their own workflow ids and history while tracking parent references.

### Side Effects

Wrap non-deterministic code in `WorkflowStub.sideEffect(fn)` to record the result once:

```typescript
const nonce = yield WorkflowStub.sideEffect(() => crypto.randomUUID());
```

Avoid throwing from side effects; place error-prone logic in activities.

---

## Activities

Activities perform IO and other non-deterministic work. Extend `Activity` and implement `execute()`:

```typescript
import { Activity } from 'durabull';
import { NonRetryableError } from 'durabull';

export class FetchInvoice extends Activity<[string], Invoice> {
  tries = 0;                // 0 = retry forever
  timeout = 15;             // seconds
  queue = 'durabull:io';    // optional queue override

  backoff() {
    return [1, 2, 5, 10, 30, 60, 120];
  }

  async execute(invoiceId: string): Promise<Invoice> {
    const res = await fetchJson(`/invoices/${invoiceId}`);
    if (res.status === 404) {
      throw new NonRetryableError('invoice not found');
    }
    return res.body;
  }
}
```

### Retry Policy

- `tries`: maximum attempts (`0` = unlimited, default).
- `timeout`: per-attempt timeout in seconds. Durabull enforces this by racing execution and rejecting when exceeded.
- `backoff()`: array of seconds for each retry. Durabull clamps to the last entry for additional attempts.

### Heartbeats

Long-running activities should periodically call `this.heartbeat()` to prevent timeout expiry:

```typescript
export class StreamToS3 extends Activity<[string], void> {
  timeout = 60;

  async execute(url: string) {
    for await (const chunk of download(url)) {
      await uploadChunk(chunk);
      this.heartbeat();
    }
  }
}
```

The runtime updates Redis heartbeat keys and worker monitors them for liveness.

### Activity Context Helpers

During execution, activities have access to:

- `this.workflowId()`: stable workflow identifier.
- `this._getLastHeartbeat()`: timestamp of the last heartbeat.
- `this.connection` / `this.queue`: runtime routing hints (optional overrides).

### Parallel & Async Helpers

`ActivityStub.make()` launches activities immediately (test-friendly). Combine them with:

- `ActivityStub.all([...])` to await a list in parallel.
- `ActivityStub.async(generatorFn)` to run lightweight in-memory subflows.

---

## Storage, History, and Persistence

Durabull persists workflow records, event history, signals, and heartbeats through an abstract `Storage` interface. The default implementation (`RedisStorage`) uses Redis data structures.

Key persisted fields include:

- `WorkflowRecord.status`: `created | pending | running | waiting | completed | failed | continued`
- `WorkflowRecord.waiting`: resume metadata for timers/awaits
- `WorkflowRecord.clockEvents`: deterministic timestamps for `WorkflowStub.now()`
- `History.events`: ordered log of activities, timers, signals, child workflows, exceptions, side effects

Custom storage implementations can be provided via `setStorage(customStorage)`.

---

## Workers

Durabull provides BullMQ-based worker helpers:

```typescript
import { startWorkflowWorker, startActivityWorker } from 'durabull/worker';

const workflowWorker = startWorkflowWorker();
const activityWorker = startActivityWorker();
```

Both workers:

- Resolve workflow/activity constructors via `registerWorkflow()` / `registerActivity()`
- Acquire Redis locks to ensure single execution per workflow/activity
- Persist history, manage wait states, and enqueue resume jobs
- Respect configured retry policies and non-retryable errors

Register classes during bootstrap (before starting workers):

```typescript
import { registerWorkflow } from 'durabull/worker/workflowWorker';
import { registerActivity } from 'durabull/worker/activityWorker';

registerWorkflow('CheckoutWorkflow', CheckoutWorkflow);
registerActivity('FetchInvoice', FetchInvoice);
```

---

## Webhooks

Durabull ships an optional webhook router for HTTP-based control:

```typescript
import express from 'express';
import { WebhookRouter, registerWebhookWorkflow } from 'durabull/webhooks';
import { GreetingWorkflow } from '../workflows/GreetingWorkflow';

registerWebhookWorkflow('greeting-workflow', GreetingWorkflow);

const app = express();
app.use(express.json());
app.use('/webhooks', WebhookRouter.routes());
```

Endpoints support:

- `POST /webhooks/start/<workflow>`
- `POST /webhooks/signal/<workflow>/<workflowId>/<signal>`

Authentication strategies (`NoneAuthStrategy`, `TokenAuthStrategy`, `SignatureAuthStrategy`) are configurable through global config.

---

## Testing

Durabull includes a `TestKit` for synchronous, deterministic tests without Redis or BullMQ.

```typescript
import { TestKit, WorkflowStub } from 'durabull/test';
import { GreetingWorkflow } from '../app/workflows/GreetingWorkflow';
import { SayHello } from '../app/activities/SayHello';

test('greets the user', async () => {
  TestKit.fake();
  TestKit.mock(SayHello, 'Hello, test!');

  const wf = await WorkflowStub.make(GreetingWorkflow);
  await wf.start('world');

  expect(await wf.output()).toBe('Hello, test!');
  TestKit.assertDispatched(SayHello, 1);
});
```

Features:

- `TestKit.fake()` routes activities through mocks/synchronous execution.
- `TestKit.mock(ActivityClass, value | fn)` provides fake results.
- `TestKit.assertDispatched`, `assertNotDispatched`, and `getDispatches` introspect activity usage.
- `TestKit.fakeTime(workflowId?)`, `TestKit.travel(amount, unit)` offer deterministic time travel.
- `TestKit.now()` returns the current virtual time (integrates with `WorkflowStub.now()`).

Restore the real runtime with `TestKit.restore()`.

---

## Determinism & Idempotency Guidelines

Workflows must be deterministic:

- Use `WorkflowStub.now()` instead of `Date.now()`.
- Wrap randomness in `WorkflowStub.sideEffect()`.
- Avoid reading mutable global state or performing IO (delegate to activities).
- Store needed data in workflow fields and signals for replay.

Activities must be idempotent:

- Compute idempotency keys using `this.workflowId()` and activity inputs.
- Ensure external side effects can tolerate retries.
- Throw `NonRetryableError` for failures that should not retry.

---

## Monitoring & Maintenance

- `WorkflowRecord.waiting` + timers allow durable sleeps without busy waiting.
- Use `RedisStorage.refreshHeartbeat` to monitor long-running activities via Redis keys.
- Invoke model pruning by deleting or archiving workflow records older than the configured `pruneAge` (Durabull exposes `closeQueues()` to clean up BullMQ connections when shutting down workers/tests).

---

## Troubleshooting

- **Jest hanging:** Ensure timers are cleared (Durabull core clears activity timeouts automatically) or run with `--detectOpenHandles` to locate user-land leaks.
- **Workflow not resuming:** Confirm the workflow worker is running and registered, and that Redis connections are reachable.
- **Signal ignored:** Verify the workflow class is registered, signal name matches the decorator, and the workflow is currently waiting.
- **Activity stuck:** Check heartbeat timestamps and confirm `this.heartbeat()` is being invoked inside long loops.

---

## Additional Resources

- [`examples/`](./examples) – Executable end-to-end samples (greeting, parallelism, signals/queries, saga, timers, heartbeats)
- `tests/` – Comprehensive Jest coverage mirroring Laravel Workflow fixtures

Durabull continues to evolve. Follow the repository for roadmap updates and contribute via pull requests or discussions.
