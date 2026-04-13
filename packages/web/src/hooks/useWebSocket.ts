import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WsEvent, Task, TaskStatus } from "@aif/shared/browser";
import { useNotificationSettings } from "./useNotificationSettings";
import { playStatusChangeBeep, showTaskMovedNotification } from "@/lib/notifications";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTaskPayload(value: unknown): value is Task {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string"
  );
}

function hasIdPayload(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string";
}

function resolveWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  return `${protocol}//${window.location.host}/ws`;
}

/** Per-client WS identifier assigned by server on connect */
let currentClientId: string | null = null;

export function getWsClientId(): string | null {
  return currentClientId;
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const queryClient = useQueryClient();
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const statusCacheRef = useRef<Map<string, TaskStatus>>(new Map());
  const intentionalCloseRef = useRef(false);
  const connectRef = useRef<() => void>(() => undefined);
  const invalidateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingTaskIds = useRef<Set<string>>(new Set());
  const { settings } = useNotificationSettings();
  // Keep settings in a ref so the connect callback doesn't depend on them.
  // This prevents WebSocket churn when notification settings change.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const findTaskStatusInCache = useCallback(
    (taskId: string): TaskStatus | null => {
      const detailed = queryClient.getQueryData<Task>(["task", taskId]);
      if (detailed) return detailed.status;

      const taskLists = queryClient.getQueriesData<Task[]>({ queryKey: ["tasks"] });
      for (const [, tasks] of taskLists) {
        if (!tasks) continue;
        const found = tasks.find((task) => task.id === taskId);
        if (found) return found.status;
      }

      return null;
    },
    [queryClient],
  );

  const connect = useCallback(() => {
    const url = resolveWsUrl();

    console.debug("[ws] Connecting to", url);
    const ws = new WebSocket(url);
    intentionalCloseRef.current = false;

    ws.onopen = () => {
      console.debug("[ws] Connected");
    };

    ws.onmessage = (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch (error) {
        console.debug("[ws] Failed to parse message:", error);
        return;
      }

      if (!isRecord(raw) || typeof raw.type !== "string") {
        console.debug("[ws] Invalid event shape");
        return;
      }

      console.debug("[ws] Event received:", raw.type);

      // Capture per-client WS identifier from server (not a WsEvent)
      if (
        raw.type === "ws:connected" &&
        isRecord(raw.payload) &&
        typeof (raw.payload as Record<string, unknown>).clientId === "string"
      ) {
        currentClientId = (raw.payload as Record<string, unknown>).clientId as string;
        console.debug("[ws] Assigned clientId:", currentClientId);
        return;
      }

      // Dispatch chat events as custom DOM events for the useChat hook
      if (
        raw.type === "chat:token" ||
        raw.type === "chat:done" ||
        raw.type === "chat:error" ||
        raw.type === "chat:session_created" ||
        raw.type === "chat:session_deleted"
      ) {
        window.dispatchEvent(new CustomEvent(raw.type, { detail: raw.payload }));
        return;
      }

      const data = raw as unknown as WsEvent;

      if (data.type === "task:moved" && isTaskPayload(data.payload)) {
        const movedTask = data.payload;
        const cachedStatus = statusCacheRef.current.get(movedTask.id);
        const previousStatus = cachedStatus ?? findTaskStatusInCache(movedTask.id);
        statusCacheRef.current.set(movedTask.id, movedTask.status);

        if (previousStatus && previousStatus !== movedTask.status) {
          if (settingsRef.current.desktop) {
            try {
              showTaskMovedNotification(
                movedTask.id,
                movedTask.title,
                previousStatus,
                movedTask.status,
              );
            } catch (error) {
              console.debug("[ws] Failed to show desktop notification:", error);
            }
          }
          if (settingsRef.current.sound) {
            void playStatusChangeBeep().catch((error) => {
              console.debug("[ws] Failed to play notification sound:", error);
            });
          }
        }
      }

      // Activity-only update: refresh task detail without touching the board list
      if (data.type === "task:activity" && hasIdPayload(data.payload)) {
        queryClient.invalidateQueries({ queryKey: ["task", data.payload.id] });
        return;
      }

      // Project auto-queue toggle changed somewhere — refresh the projects
      // list so the Switch in the project settings dialog stays in sync.
      if (data.type === "project:auto_queue_mode_changed") {
        queryClient.invalidateQueries({ queryKey: ["projects"] });
        if (hasIdPayload(data.payload)) {
          queryClient.invalidateQueries({ queryKey: ["autoQueueMode", data.payload.id] });
        }
        return;
      }

      if (data.type === "task:deleted" && hasIdPayload(data.payload)) {
        statusCacheRef.current.delete(data.payload.id);
        // Remove the individual task query from cache instead of invalidating
        // (invalidating would trigger a refetch of the deleted task → 404)
        queryClient.removeQueries({
          queryKey: ["task", data.payload.id],
        });
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        return;
      }

      // Dispatch roadmap events as custom DOM events for listeners
      if (data.type === "roadmap:complete" || data.type === "roadmap:error") {
        window.dispatchEvent(new CustomEvent(data.type, { detail: data.payload }));

        if (data.type === "roadmap:complete" && isRecord(data.payload)) {
          const p = data.payload as { roadmapAlias?: string; created?: number };
          if (settingsRef.current.desktop && Notification.permission === "granted") {
            new Notification("Roadmap ready", {
              body: `${p.roadmapAlias}: ${p.created ?? 0} task(s) created`,
              tag: "roadmap-complete",
            });
          }
          if (settingsRef.current.sound) {
            void playStatusChangeBeep().catch(() => {});
          }
        }
      }

      // Batch invalidation: debounce 150ms to coalesce rapid WS events
      if (hasIdPayload(data.payload)) {
        pendingTaskIds.current.add(data.payload.id);
      }
      clearTimeout(invalidateTimer.current);
      invalidateTimer.current = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        for (const id of pendingTaskIds.current) {
          queryClient.invalidateQueries({ queryKey: ["task", id] });
        }
        pendingTaskIds.current.clear();
      }, 150);
    };

    ws.onclose = () => {
      if (intentionalCloseRef.current) {
        return;
      }
      console.debug("[ws] Disconnected, reconnecting in 3s...");
      reconnectTimer.current = setTimeout(() => connectRef.current(), 3000);
    };

    ws.onerror = (error) => {
      console.debug("[ws] Error:", error);
      ws.close();
    };

    wsRef.current = ws;
  }, [findTaskStatusInCache, queryClient]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearTimeout(invalidateTimer.current);
      const ws = wsRef.current;
      if (!ws) return;

      intentionalCloseRef.current = true;

      // In React.StrictMode (dev) effect cleanup can happen while socket is still
      // connecting; closing it immediately causes noisy browser console errors.
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener(
          "open",
          () => {
            ws.close();
          },
          { once: true },
        );
        return;
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [connect]);
}
