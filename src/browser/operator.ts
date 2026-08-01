import type { AgentResult } from "../domain/models.js";
import type { WorkerCommand } from "../domain/schemas.js";

export interface BrowserOperator {
  execute(command: WorkerCommand): Promise<AgentResult<unknown>>;
}
