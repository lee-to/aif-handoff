import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast";
import type { TaskCommitPayload } from "@aif/shared/browser";

// Dedupe window for (taskId, type) pairs. StrictMode double-mount, transient
// dual WS connections during reconnect, and server re-broadcasts can all
// deliver the same commit event more than once. 2s is long enough to swallow
// those, short enough that a genuine repeat (e.g. second manual approve) still
// produces a fresh toast.
const DEDUPE_WINDOW_MS = 2000;

/**
 * Global listener for `task:commit_*` WS events. Mounts once (in <App/>) and
 * converts the event stream into toasts so the user always gets feedback on
 * the approve-done auto-commit flow — regardless of whether the task detail
 * modal is open.
 */
export function useCommitToasts() {
  const { toast } = useToast();
  const lastSeenRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const seen = lastSeenRef.current;
    const shouldSkip = (type: string, taskId: string | undefined): boolean => {
      const key = `${type}:${taskId ?? "unknown"}`;
      const now = Date.now();
      const prev = seen.get(key);
      if (prev && now - prev < DEDUPE_WINDOW_MS) return true;
      seen.set(key, now);
      return false;
    };

    const onStarted = (e: Event) => {
      const detail = (e as CustomEvent<TaskCommitPayload>).detail;
      if (shouldSkip("started", detail?.taskId)) return;
      console.debug("[commit-toast] started", detail);
      toast("Creating commit…", "info", 6000);
    };
    const onDone = (e: Event) => {
      const detail = (e as CustomEvent<TaskCommitPayload>).detail;
      if (shouldSkip("done", detail?.taskId)) return;
      console.debug("[commit-toast] done", detail);
      toast("Commit created", "success", 4000);
    };
    const onFailed = (e: Event) => {
      const detail = (e as CustomEvent<TaskCommitPayload>).detail;
      if (shouldSkip("failed", detail?.taskId)) return;
      console.debug("[commit-toast] failed", detail);
      toast(`Commit failed: ${detail?.error ?? "unknown error"}`, "error", 8000);
    };

    window.addEventListener("task:commit_started", onStarted);
    window.addEventListener("task:commit_done", onDone);
    window.addEventListener("task:commit_failed", onFailed);

    return () => {
      window.removeEventListener("task:commit_started", onStarted);
      window.removeEventListener("task:commit_done", onDone);
      window.removeEventListener("task:commit_failed", onFailed);
    };
  }, [toast]);
}
