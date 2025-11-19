# 🐃 Durabull

**Durable, replay-safe workflow orchestration for TypeScript & Node.js — powered by BullMQ and Redis.**

> Generator-based workflows that combine the elegance of Laravel Workflow with the reliability of Temporal.

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/types-TypeScript-blue.svg">
  <img alt="Status" src="https://img.shields.io/badge/status-early%20access-orange.svg">
</p>

---

## ✨ Overview

Durabull brings **generator-based workflow orchestration** to TypeScript.
Author workflows as `async *execute()` coroutines, orchestrate idempotent activities, and run them safely on top of **BullMQ** and **Redis** — with full deterministic replay guarantees.

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install durabull
# or
pnpm add durabull
```

### 2. Configure Durabull

```typescript
import { Durabull } from 'durabull';

const durabull = new Durabull({
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queues: {
    workflow: 'durabull-workflow',
    activity: 'durabull-activity',
  },
  serializer: 'json',
  pruneAge: '30 days',
  // Optional: Queue routing for multi-tenant support
  queueRouter: (workflowName, context) => {
    const tenant = context?.tenantId;
    return tenant ? {
      workflow: `tenant-${tenant}-workflow`,
      activity: `tenant-${tenant}-activity`,
    } : undefined;
  },
  // Optional: Lifecycle hooks for observability
  lifecycleHooks: {
    workflow: {
      onStart: async (id, name, args) => console.log(`Workflow ${name} started`),
      onComplete: async (id, name, output) => console.log(`Workflow ${name} completed`),
      onFailed: async (id, name, error) => console.error(`Workflow ${name} failed`, error),
    },
  },
  // logger: optional structured logger with info/warn/error/debug methods
});

durabull.setActive();
```

### 3. Create an Activity

```typescript
import { Activity } from 'durabull';

export class SayHello extends Activity<[string], string> {
  tries = 3;
  timeout = 5; // seconds

  async execute(name: string): Promise<string> {
    return `Hello, ${name}!`;
  }
}
```

### 4. Create a Workflow

```typescript
import { Workflow, ActivityStub } from 'durabull';
import { SayHello } from './SayHello';

export class GreetingWorkflow extends Workflow<[string], string> {
  async *execute(name: string) {
    const message = yield ActivityStub.make(SayHello, name);
    return message;
  }
}
```

### 5. Execute the Workflow

```typescript
import { WorkflowStub } from 'durabull';
import { GreetingWorkflow } from './GreetingWorkflow';

const wf = await WorkflowStub.make(GreetingWorkflow);
await wf.start('World');

console.log(await wf.output()); // "Hello, World!"
```

### 🪝 Webhooks

Expose workflows via HTTP using `createWebhookRouter`.

```typescript
import { createWebhookRouter, TokenAuthStrategy } from 'durabull';
import { GreetingWorkflow } from './GreetingWorkflow';

const router = createWebhookRouter({
  authStrategy: new TokenAuthStrategy('my-secret-token'),
});

router.registerWebhookWorkflow('greeting', GreetingWorkflow);

// Use with Express/Fastify/etc.
app.post('/webhooks/*', async (req, res) => {
  const response = await router.handle({
    method: req.method,
    path: req.path,
    headers: req.headers,
    body: req.body,
  });
  res.status(response.statusCode).send(response.body);
});
```

---

## 🧠 Why Durabull?

| Capability                       | Description                                                              |
| -------------------------------- | ------------------------------------------------------------------------ |
| 🧩 **Generator-based workflows** | Use `async *execute()` and `yield` for deterministic orchestration.      |
| ⚙️ **Idempotent activities**     | Encapsulate retries, backoff, and heartbeats for safe IO.                |
| ⏳ **Deterministic replay**       | Rebuild workflow state from event history — crash-safe and restart-safe. |
| 💬 **Signals & Queries**         | Interact dynamically with live workflows via decorators.                 |
| 🧵 **Saga & Compensation**       | Built-in support for distributed transactions.                           |
| ⏱ **Timers & Await**             | Durable timers via `WorkflowStub.timer()` and `WorkflowStub.await()`.    |
| 🩺 **Observability**             | Full event history, heartbeats, and pruning controls.                    |
| 🪝 **Webhooks**                  | Trigger workflows and signals via HTTP with pluggable auth.              |

---

## 💡 Core Concepts

### 🧭 Workflows

Extend `Workflow` and implement `async *execute()`.

Use `ActivityStub.make()` or `ActivityStub.all()` to orchestrate sequential or parallel work.

```typescript
import { Workflow, ActivityStub } from 'durabull';
import { ChargeCard, EmailReceipt } from './activities';

export class CheckoutWorkflow extends Workflow<[string, number], string> {
  async *execute(orderId, amount) {
    const chargeId = yield ActivityStub.make(ChargeCard, orderId, amount);
    yield ActivityStub.make(EmailReceipt, orderId, chargeId);
    return chargeId;
  }
}
```

### ⚡ Activities

Extend `Activity` and implement `execute()`.
Configure retry logic and call `this.heartbeat()` for long-running jobs.

```typescript
import { Activity, NonRetryableError } from 'durabull';

export class ChargeCard extends Activity<[string, number], string> {
  tries = 5;
  timeout = 15;

  async execute(orderId, amount) {
    const res = await paymentGateway.charge(orderId, amount);
    if (!res.ok) throw new NonRetryableError(res.error);
    return res.chargeId;
  }
}
```

---

## 🧩 Examples

Run any example from the `/examples` directory:

```bash
npm run example:greeting          # Basic workflow + activity
```

---


## 🧭 Documentation

* 📘 [`DOCS.md`](./DOCS.md) — Full Durabull guide for TypeScript users
* 💡 [`examples/`](./examples) — Complete working examples
* 🧪 [`tests/`](./tests) — Jest test suite covering all core behaviors

---

## 🤝 Contributing

We welcome contributions!

1. Fork the repository
2. Create a new branch (`feat/my-feature`)
3. Write tests and ensure `npm test` passes
4. Lint code (`npm run lint`)
5. Open a pull request with a clear description

---

## License

**Durabull** is open-source software licensed under the **[MIT License](./LICENSE)**.
© 2025 Durabull contributors.
