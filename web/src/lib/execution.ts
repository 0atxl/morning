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

export const executionStages: {
  stage: DotStructureState;
  label: string;
  name: string;
  previewOnly?: boolean;
}[] = [
  { stage: "ORB", label: "ORB", name: "Ready" },
  { stage: "STT", label: "STT", name: "Transcription" },
  {
    stage: "NOTEPAD",
    label: "PAD",
    name: "Meeting minutes",
    previewOnly: true,
  },
  { stage: "PEN", label: "PEN", name: "Correction", previewOnly: true },
  { stage: "MAIL", label: "MAIL", name: "Email draft" },
  { stage: "DIAL", label: "DIAL", name: "Reminder" },
];
