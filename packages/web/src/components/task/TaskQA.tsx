import { useState } from "react";
import { Maximize2 } from "lucide-react";
import type { Task } from "@aif/shared/browser";
import { Markdown } from "@/components/ui/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AlertBox } from "@/components/ui/alert-box";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Section } from "./Section";

interface TaskQAProps {
  task: Task;
  onRunQa: () => void;
  onRunQaCheck: () => void;
  isRunning: boolean;
  isQaCheckRunning: boolean;
}

const STATUS_LABEL: Record<Task["qaStatus"], string> = {
  idle: "Idle",
  running: "Running",
  done: "Done",
  error: "Error",
};

const STATUS_VARIANT: Record<Task["qaStatus"], "outline" | "secondary" | "default" | "error"> = {
  idle: "outline",
  running: "secondary",
  done: "default",
  error: "error",
};

const MARKDOWN_CLASS =
  "text-xs leading-5 text-foreground/95 [&_code]:bg-background/70 [&_code]:px-1 [&_code]:py-0 [&_code]:text-[0.92em] [&_h1]:mb-1 [&_h1]:mt-2 [&_h2]:mb-1 [&_h2]:mt-2 [&_h3]:mb-1 [&_h3]:mt-2 [&_li]:my-0.5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1";

function QaArtifact({ content }: { content: string | null }) {
  if (!content?.trim()) {
    return <EmptyState message="Not generated yet" />;
  }
  return (
    <div className="max-h-64 overflow-x-auto overflow-y-auto border border-border bg-secondary/40 p-3">
      <Markdown content={content} className={MARKDOWN_CLASS} />
    </div>
  );
}

interface QaArtifactSpec {
  title: string;
  content: string | null;
}

export function TaskQA({ task, onRunQa, onRunQaCheck, isRunning, isQaCheckRunning }: TaskQAProps) {
  const canRun = task.status === "done" || task.status === "verified";
  const anyRunning = isRunning || isQaCheckRunning;
  const disabled = anyRunning || !canRun;
  const hasTestCases = Boolean(task.qaTestCases?.trim());
  const checkDisabled = anyRunning || !canRun || !hasTestCases;
  const [expanded, setExpanded] = useState<QaArtifactSpec | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checkConfirmOpen, setCheckConfirmOpen] = useState(false);

  const artifacts: QaArtifactSpec[] = [
    { title: "Change Summary", content: task.qaChangeSummary },
    { title: "Test Plan", content: task.qaTestPlan },
    { title: "Test Cases", content: task.qaTestCases },
    { title: "QA Check", content: task.qaCheckReport },
  ];

  // Re-running overwrites existing artifacts, so confirm first when any exist.
  const hasArtifacts = artifacts.some((a) => a.content?.trim());
  const handleRunClick = () => {
    if (hasArtifacts) {
      setConfirmOpen(true);
    } else {
      onRunQa();
    }
  };
  const handleRunCheckClick = () => {
    if (task.qaCheckReport?.trim()) {
      setCheckConfirmOpen(true);
    } else {
      onRunQaCheck();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-background/55 p-3">
        <div className="flex items-center gap-2">
          <Button size="xs" onClick={handleRunClick} disabled={disabled} className="gap-1.5">
            {isRunning ? (
              <>
                <Spinner size="sm" /> Running…
              </>
            ) : (
              "Run QA"
            )}
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={handleRunCheckClick}
            disabled={checkDisabled}
            className="gap-1.5"
          >
            {isQaCheckRunning ? (
              <>
                <Spinner size="sm" /> Checking…
              </>
            ) : (
              "Run QA Check"
            )}
          </Button>
          {!canRun && (
            <span className="text-xs text-muted-foreground">
              QA is available once the task reaches Done or Verified.
            </span>
          )}
          {canRun && !hasTestCases && (
            <span className="text-xs text-muted-foreground">Generate test cases first.</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>QA</span>
          <Badge size="sm" variant={STATUS_VARIANT[task.qaStatus]}>
            {STATUS_LABEL[task.qaStatus]}
          </Badge>
          <span>Check</span>
          <Badge size="sm" variant={STATUS_VARIANT[task.qaCheckStatus]}>
            {STATUS_LABEL[task.qaCheckStatus]}
          </Badge>
        </div>
      </div>

      {task.qaStatus === "error" && (
        <AlertBox variant="error" className="text-xs">
          The QA run failed. Check the agent logs and try running QA again.
        </AlertBox>
      )}

      {task.qaCheckStatus === "error" && (
        <AlertBox variant="error" className="text-xs">
          The QA Check run failed. Check the agent logs and try again.
        </AlertBox>
      )}

      {task.qaCheckPlaywrightConfigured === false && (
        <AlertBox variant="warning" className="text-xs">
          Playwright MCP was not configured for the last QA Check. Browser cases may be Blocked;
          non-browser checks still run.
        </AlertBox>
      )}

      {artifacts.map((artifact) => (
        <Section
          key={artifact.title}
          title={artifact.title}
          actions={
            artifact.content?.trim() ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setExpanded(artifact)}
                className="gap-1"
                aria-label={`Expand ${artifact.title}`}
              >
                <Maximize2 className="h-3 w-3" /> Expand
              </Button>
            ) : undefined
          }
        >
          <QaArtifact content={artifact.content} />
        </Section>
      ))}

      <Dialog open={expanded !== null} onOpenChange={(open) => !open && setExpanded(null)}>
        <DialogContent className="max-w-4xl">
          <DialogClose onClose={() => setExpanded(null)} />
          <DialogHeader>
            <DialogTitle>{expanded?.title}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-x-auto overflow-y-auto border border-border bg-secondary/40 p-4">
            {expanded?.content ? (
              <Markdown content={expanded.content} className={MARKDOWN_CLASS} />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Re-run QA?"
        description="This overwrites the QA planning artifacts and clears the previous QA Check report for this task."
        confirmLabel="Re-run QA"
        variant="destructive"
        onConfirm={() => {
          setConfirmOpen(false);
          onRunQa();
        }}
      />

      <ConfirmDialog
        open={checkConfirmOpen}
        onOpenChange={setCheckConfirmOpen}
        title="Re-run QA Check?"
        description="This overwrites the existing QA Check report for this task."
        confirmLabel="Re-run QA Check"
        variant="destructive"
        onConfirm={() => {
          setCheckConfirmOpen(false);
          onRunQaCheck();
        }}
      />
    </div>
  );
}
