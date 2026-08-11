import {
  STATUS_CONFIG,
  type ExecutionOwner,
  type TaskAssigneeSummary,
  type TaskStatus,
} from "@aif/shared/browser";

let audioContext: AudioContext | null = null;

function getStatusLabel(status: TaskStatus) {
  return STATUS_CONFIG[status].label;
}

export function showTaskMovedNotification(
  taskId: string,
  taskTitle: string,
  from: TaskStatus,
  to: TaskStatus,
) {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;

  const fromLabel = getStatusLabel(from);
  const toLabel = getStatusLabel(to);

  new Notification(`Task moved: ${taskTitle}`, {
    body: `${fromLabel} -> ${toLabel}`,
    tag: `task-status-${taskId}`,
  });
}

export function showTaskAssignmentNotification(
  taskId: string,
  taskTitle: string,
  executionOwner: ExecutionOwner,
  assignees: TaskAssigneeSummary[],
) {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  const responsibility =
    executionOwner === "ai"
      ? "AI"
      : assignees.length > 0
        ? assignees.map((assignee) => assignee.displayName).join(", ")
        : "Unassigned";

  new Notification(`Task assignment: ${taskTitle}`, {
    body: `Responsible: ${responsibility}`,
    tag: `task-assignment-${taskId}`,
  });
}

export async function playStatusChangeBeep() {
  if (typeof window === "undefined") return;
  const AudioCtx =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;

  if (!audioContext) audioContext = new AudioCtx();
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;

  osc.type = "sine";
  osc.frequency.setValueAtTime(1046.5, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(now);
  osc.stop(now + 0.18);
}
