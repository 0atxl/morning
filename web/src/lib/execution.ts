import type { DotStructureState } from "./dot-field";

// Minutes and corrections can report the same event when those flows land.
// requestId is set when a finalized request starts, and retained on its retries.
export type ExecutionActivity = {
  requestId: string | null;
  stages: DotStructureState[];
  status: string;
  running: boolean;
};

export const idleExecution: ExecutionActivity = {
  requestId: null,
  stages: ["ORB"],
  status: "Ready",
  running: false,
};
