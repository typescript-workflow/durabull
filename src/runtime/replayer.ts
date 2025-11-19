import { Workflow } from '../Workflow';
import { WorkflowRecord } from './history';
import { getStorage } from './storage';
import { ReplayEngine, ReplayResult } from './ReplayEngine';

export { ReplayResult };

export async function replayWorkflow(
  workflowId: string,
  WorkflowClass: new () => Workflow<unknown[], unknown>,
  record?: WorkflowRecord
): Promise<ReplayResult> {
  const storage = getStorage();
  
  if (!record) {
    const loadedRecord = await storage.readRecord(workflowId);
    if (!loadedRecord) {
      throw new Error(`Workflow ${workflowId} not found`);
    }
    record = loadedRecord;
  }

  const history = (await storage.readHistory(workflowId)) || { events: [], cursor: 0 };
  const workflow = new WorkflowClass();
  const signals = await storage.listSignals(workflowId);

  return ReplayEngine.run({
    workflowId,
    workflow,
    record,
    history,
    signals,
    isResume: true,
  });
}
