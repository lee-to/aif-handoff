import { RuntimeTransport } from "@aif/runtime";

export function getCodexExecutionHooks(input: {
  runtimeId: string;
  transport: string;
  bypassPermissions: boolean;
}): Record<string, unknown> {
  if (input.runtimeId !== "codex" || input.transport !== RuntimeTransport.SDK) {
    return {};
  }

  return {
    approvalPolicy: input.bypassPermissions ? "never" : "on-request",
    sandboxMode: "workspace-write",
  };
}
