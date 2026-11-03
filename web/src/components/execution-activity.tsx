import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExecutionDotMorph } from "@/components/dot-morph";
import { executionStages, type ExecutionActivity } from "@/lib/execution";
import type { DotStructureState } from "@/lib/dot-field";
import type { WorkspaceResult } from "@/lib/results";

export function ExecutionActivityView({
  execution,
  preview,
  results,
  lastEdited,
}: {
  execution: ExecutionActivity;
  preview: boolean;
  results: WorkspaceResult[];
  lastEdited: string | null;
}) {
  const [shape, setShape] = useState<DotStructureState | null>(null);
  const selected = preview ? shape : null;
  const stages = selected ? [selected] : execution.stages;
  const label = executionStages.find((item) => item.stage === selected)?.name;
  const commands = new Map<string, WorkspaceResult[]>();
  for (const result of results) {
    const id = "commandId" in result ? String(result.commandId) : result.id;
    commands.set(id, [...(commands.get(id) ?? []), result]);
  }

  return (
    <>
      <div className="execution-figure">
        <ExecutionDotMorph
          state={stages[0] ?? "ORB"}
          running={selected ? true : execution.running}
        />
        <ul
          className="execution-rail"
          aria-label={preview ? "Design preview shapes" : "Activity stages"}
        >
          {executionStages.map((item) => (
            <li
              key={item.stage}
              data-active={stages.includes(item.stage)}
              data-preview-only={item.previewOnly || undefined}
            >
              {preview ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={stages.includes(item.stage)}
                  aria-label={`${item.name} preview`}
                  onClick={() => setShape(item.stage)}
                >
                  {item.label}
                </Button>
              ) : (
                <span
                  title={`${item.name}${item.previewOnly ? " · Design preview only" : ""}`}
                >
                  {item.label}
                  <span className="sr-only">
                    {item.previewOnly
                      ? ", design preview only"
                      : stages.includes(item.stage)
                        ? ", current"
                        : ""}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="execution-status" role="status">
          {selected
            ? `${label} preview`
            : `${preview ? "Preview: " : ""}${execution.status}`}
        </p>
        {preview && selected ? (
          <Button
            variant="ghost"
            size="sm"
            className="execution-reset"
            onClick={() => setShape(null)}
          >
            Follow preview state
          </Button>
        ) : null}
      </div>
      {results.length || lastEdited ? (
        <ul className="activity-list">
          {lastEdited ? (
            <li>
              <Pencil aria-hidden="true" />
              <div>
                <span>{preview ? "Updated in preview" : "Updated"}</span>
                <p>{lastEdited}</p>
              </div>
            </li>
          ) : null}
          {[...commands].map(([id, records]) => (
            <li key={id}>
              <Check aria-hidden="true" />
              <div>
                <span>
                  {records.length > 1
                    ? "Draft and reminder saved together"
                    : records[0].kind === "draft"
                      ? "Draft saved"
                      : "Reminder saved"}
                </span>
                <p>{records.map((result) => result.title).join(" · ")}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel-empty">No saved activity yet.</p>
      )}
    </>
  );
}
