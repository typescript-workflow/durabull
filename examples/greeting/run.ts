/**
 * Simple greeting workflow example
 */

import { Workflow, WorkflowStub, Activity, ActivityStub } from '../../src';

class GreetingActivity extends Activity<[string], string> {
  async execute(name: string): Promise<string> {
    return `Hello, ${name}!`;
  }
}

export class GreetingWorkflow extends Workflow<[string], string> {
  async *execute(name: string): AsyncGenerator<string> {
    const message = (yield ActivityStub.make(GreetingActivity, name)) as string;
    return message;
  }
}

export async function run(): Promise<void> {
  const workflow = await WorkflowStub.make(GreetingWorkflow);
  await workflow.start('world');
  const message = await workflow.output();
  console.log(message);
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Greeting example failed:', error);
    process.exit(1);
  });
}
