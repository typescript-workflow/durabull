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
npm install durabull bullmq ioredis
# or
pnpm add durabull bullmq ioredis
```

### 2. Configure Durabull

```typescript
import { Durabull } from 'durabull';

Durabull.configure({
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queues: {
    workflow: 'durabull:workflow',
    activity: 'durabull:activity',
  },
  serializer: 'json',
  pruneAge: '30 days',
  // logger: optional structured logger with info/warn/error/debug methods
});
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

## 🧪 Testing

Durabull ships with a purpose-built `TestKit`:

```typescript
import { TestKit, WorkflowStub } from 'durabull/test';
import { GreetingWorkflow } from '../workflows/GreetingWorkflow';
import { SayHello } from '../activities/SayHello';

it('greets users', async () => {
  TestKit.fake();
  TestKit.mock(SayHello, 'Hi!');

  const wf = await WorkflowStub.make(GreetingWorkflow);
  await wf.start('world');

  expect(await wf.output()).toBe('Hi!');
  TestKit.assertDispatched(SayHello, 1);

  TestKit.restore();
});
```

✅ Mock activities
✅ Fake Redis + BullMQ
✅ Time travel (`TestKit.travel()`)
✅ Deterministic replay

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

---

<p align="center">
  <sub>Built with ❤️  for the TypeScript workflow community — inspired by Laravel Workflow & Temporal.</sub>
</p>
