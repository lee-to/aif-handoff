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
  const { settings } = useNotificationSettings();

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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

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
          if (settings.desktop) {
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
          if (settings.sound) {
            void playStatusChangeBeep().catch((error) => {
              console.debug("[ws] Failed to play notification sound:", error);
            });
          }
        }
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
          if (settings.desktop && Notification.permission === "granted") {
            new Notification("Roadmap ready", {
              body: `${p.roadmapAlias}: ${p.created ?? 0} task(s) created`,
              tag: "roadmap-complete",
            });
          }
          if (settings.sound) {
            void playStatusChangeBeep().catch(() => {});
          }
        }
      }

      // Invalidate tasks query to trigger refetch
      queryClient.invalidateQueries({ queryKey: ["tasks"] });

      // If task detail is open, also invalidate individual task
      if (hasIdPayload(data.payload)) {
        queryClient.invalidateQueries({
          queryKey: ["task", data.payload.id],
        });
      }
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
  }, [findTaskStatusInCache, queryClient, settings.desktop, settings.sound]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
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
