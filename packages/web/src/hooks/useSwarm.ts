import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SWARM_NOTIFICATION_EVENTS, type SwarmEvent } from "@aif/shared/browser";
import { api, ApiError } from "@/lib/api";
import { SwarmEventBuffer, SwarmReplayGapError, swarmRetryDelay } from "@/lib/swarm";
import { useToast } from "@/components/ui/toast";
import { useNotificationSettings } from "./useNotificationSettings";

export function useSwarmConnection() {
  return useQuery({
    queryKey: ["swarm", "connection"],
    queryFn: api.getSwarmConnection,
    retry: false,
  });
}
export function useSwarmRuns(enabled: boolean) {
  return useQuery({
    queryKey: ["swarm", "runs"],
    queryFn: api.listSwarmRuns,
    enabled,
    refetchInterval: 10_000,
    retry: false,
  });
}

export function useSwarmRun(runId: string | null) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { settings } = useNotificationSettings();
  const desktop = useRef(settings.desktop);
  useEffect(() => {
    desktop.current = settings.desktop;
  }, [settings.desktop]);
  const query = useQuery({
    queryKey: ["swarm", "run", runId],
    queryFn: () => api.getSwarmSnapshot(runId!),
    enabled: Boolean(runId),
    refetchInterval: 15_000,
    retry: false,
  });
  const [state, setState] = useState<{
    runId: string | null;
    live: boolean;
    events: SwarmEvent[];
    historyGap: boolean;
  }>({ runId: null, live: false, events: [], historyGap: false });

  // eslint-disable-next-line react-hooks/immutability -- Only the effect-local replay buffer mutates; runId is an immutable string.
  useEffect(() => {
    if (!runId) return;
    const abort = new AbortController();
    const buffer = new SwarmEventBuffer(`${runId}`);
    let initialSequence: number | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = () =>
      queryClient.fetchQuery({
        queryKey: ["swarm", "run", runId],
        queryFn: () => api.getSwarmSnapshot(runId),
        staleTime: 0,
      });
    const accept = (event: SwarmEvent) => {
      if (abort.signal.aborted || !buffer.accept(event)) return;
      setState((current) => ({ ...current, runId, events: buffer.events }));
      if (
        initialSequence !== null &&
        event.sequence > initialSequence &&
        SWARM_NOTIFICATION_EVENTS.has(event.type)
      ) {
        const message = `Swarm ${event.type.replaceAll(".", " ")}`;
        toast(message, event.type === "run.completed" ? "success" : "warning");
        if (
          desktop.current &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          new Notification(message, { body: `Run ${runId}`, tag: `swarm-${event.event_id}` });
        }
      }
      if (!refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void queryClient.invalidateQueries({ queryKey: ["swarm", "run", runId] });
          void queryClient.invalidateQueries({ queryKey: ["swarm", "runs"] });
        }, 500);
    };
    const connect = async () => {
      let backoff = 1000;
      while (!abort.signal.aborted) {
        try {
          const current = await snapshot();
          if (abort.signal.aborted) return;
          if (initialSequence === null) {
            initialSequence = current.sequence;
            buffer.reset(Math.max(0, current.sequence - 200));
          }
          if (current.sequence < buffer.after)
            throw new SwarmReplayGapError("Runtime cursor moved backwards");
          // eslint-disable-next-line react-hooks/immutability -- The API receives a string and numeric cursor, neither can be mutated.
          const replay = await api.getSwarmEvents(runId, buffer.after);
          replay.events.forEach(accept);
          await api.streamSwarmEvents(runId, buffer.after, abort.signal, accept, () => {
            backoff = 1000;
            setState((previous) => ({ ...previous, runId, live: true, events: buffer.events }));
          });
        } catch (error) {
          if (abort.signal.aborted) return;
          if (
            error instanceof SwarmReplayGapError ||
            (error instanceof ApiError && error.status === 409)
          ) {
            try {
              const current = await snapshot();
              if (abort.signal.aborted) return;
              buffer.reset(current.sequence);
              initialSequence = current.sequence;
              setState({ runId, live: false, events: [], historyGap: true });
            } catch {
              /* Keep the stale snapshot and retry when Runtime returns. */
            }
          }
        }
        if (abort.signal.aborted) return;
        setState((previous) => ({ ...previous, runId, live: false }));
        await swarmRetryDelay(abort.signal, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    };
    void connect();
    return () => {
      abort.abort();
      clearTimeout(refreshTimer);
    };
  }, [runId, queryClient, toast]);

  const current = state.runId === runId ? state : { live: false, events: [], historyGap: false };
  return {
    ...query,
    events: current.events,
    historyGap: current.historyGap,
    stale: !current.live || query.isError,
    lastSyncedAt: query.dataUpdatedAt || null,
  };
}
