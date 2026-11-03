import { ExecutionDotMorph } from "@/components/dot-morph";
import type { ExecutionActivity } from "@/lib/execution";

export function ExecutionActivityView({
  execution,
}: {
  execution: ExecutionActivity;
}) {
  return (
    <div className="execution-figure">
      <ExecutionDotMorph
        state={execution.stages[0] ?? "ORB"}
        running={execution.running}
      />
      <p className="execution-status" role="status">
        {execution.status}
      </p>
    </div>
  );
}
