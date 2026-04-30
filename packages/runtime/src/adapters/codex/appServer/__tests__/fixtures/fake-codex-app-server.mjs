#!/usr/bin/env node

import readline from "node:readline";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "run-success";
const reader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let threadId = "thread-1";
let turnCounter = 0;
let turnId = "turn-1";
let waitingForInterrupt = false;
let interruptFallbackTimer = null;
let experimentalApiCapability = false;
const pendingApprovalRequests = new Map();

if (scenario === "malformed-json-on-start") {
  process.stdout.write("{malformed-json\n");
}
if (scenario === "stderr-noise") {
  process.stderr.write("fake-codex-app-server stderr diagnostic\n");
}
if (scenario === "exit-immediately") {
  process.exit(17);
}

function writeJsonLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendResult(id, result) {
  writeJsonLine({
    id,
    result,
  });
}

function sendError(id, code, message, data) {
  writeJsonLine({
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  });
}

function sendNotification(method, params = {}) {
  writeJsonLine({
    method,
    params,
  });
}

function makeTurn(status = "completed") {
  return {
    id: turnId,
    items: [],
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function makeThread(overrides = {}) {
  return {
    id: threadId,
    preview: "Hello from stored thread",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1776938000,
    updatedAt: 1776938060,
    status: { type: "notLoaded" },
    path: "/tmp/fake-thread.jsonl",
    cwd: "/tmp/fake",
    cliVersion: "0.122.0",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Stored Codex Thread",
    turns: [],
    ...overrides,
  };
}

function sendUsage(inputTokens, outputTokens) {
  sendNotification("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      last: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      total: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: null,
    },
  });
}

function completeTurn(text, usage) {
  sendNotification("item/agentMessage/delta", {
    threadId,
    turnId,
    itemId: "item-message-1",
    delta: text,
  });
  sendUsage(usage.inputTokens, usage.outputTokens);
  sendNotification("turn/completed", {
    threadId,
    turn: makeTurn("completed"),
  });
}

function failTurnForDeniedApproval() {
  sendNotification("turn/completed", {
    threadId,
    turn: {
      ...makeTurn("failed"),
      error: {
        message: "Codex app-server approval request denied by AIF",
        category: "permission",
        adapterCode: "CODEX_PERMISSION_DENIED",
      },
    },
  });
}

function sendApprovalRequest(kind) {
  const id = `server-request-${kind}`;
  pendingApprovalRequests.set(id, kind);

  if (kind === "command") {
    writeJsonLine({
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: "item-command-1",
        command: "npm install",
        reason: "needs write access",
        reasoning: "private",
      },
    });
    return;
  }

  if (kind === "file-change") {
    writeJsonLine({
      id,
      method: "item/fileChange/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: "item-file-change-1",
        changes: [{ path: "package.json", action: "modify" }],
        reason: "needs to edit package metadata",
        reasoning: "private",
      },
    });
    return;
  }

  writeJsonLine({
    id,
    method: "item/permissions/requestApproval",
    params: {
      threadId,
      turnId,
      itemId: "item-permissions-1",
      permissions: {
        network: true,
        writeRoots: ["/tmp/outside-workspace"],
      },
      reason: "needs broader permissions",
      reasoning: "private",
    },
  });
}

function handleApprovalResponse(message) {
  const id = String(message.id);
  const kind = pendingApprovalRequests.get(id);
  if (!kind) {
    return false;
  }
  pendingApprovalRequests.delete(id);

  if (message.error) {
    failTurnForDeniedApproval();
    return true;
  }

  const result = message.result && typeof message.result === "object" ? message.result : {};
  if (result.decision === "decline") {
    failTurnForDeniedApproval();
    return true;
  }
  if (kind === "permissions") {
    const permissions =
      result.permissions && typeof result.permissions === "object" ? result.permissions : {};
    if (Object.keys(permissions).length === 0) {
      failTurnForDeniedApproval();
      return true;
    }
  }

  completeTurn("Approved fake app-server request", {
    inputTokens: 1,
    outputTokens: 1,
  });
  return true;
}

function handleRequest(message) {
  if (handleApprovalResponse(message)) {
    return;
  }

  const id = message.id;
  const method = typeof message.method === "string" ? message.method : null;
  const params = message.params && typeof message.params === "object" ? message.params : {};

  if (!method) {
    if (id != null) {
      sendError(id, -32600, "Invalid request");
    }
    return;
  }

  if (id == null) {
    return;
  }

  if (scenario === "notification-before-success" && method === "echo") {
    sendNotification("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: "item-notification-before-success",
      delta: "notification-before-success",
    });
    sendResult(id, { ok: true });
    return;
  }

  switch (method) {
    case "initialize": {
      if (scenario === "rpc-error-on-initialize") {
        sendError(id, -32001, "initialize failed", { category: "auth" });
        return;
      }
      experimentalApiCapability = params.capabilities?.experimentalApi === true;
      sendResult(id, {
        userAgent: "fake-codex-app-server/1.0.0",
        codexHome: "/tmp/fake-codex",
        platformFamily: "test",
        platformOs: "test",
      });
      return;
    }

    case "echo": {
      if (scenario === "rpc-error") {
        sendError(id, -32000, "rpc failed", { category: "transport" });
        return;
      }
      if (scenario === "malformed-after-request") {
        process.stdout.write("not-json\n");
        return;
      }
      if (scenario === "exit-before-response") {
        process.exit(18);
      }
      sendResult(id, {
        echo: params,
      });
      return;
    }

    case "model/list": {
      sendResult(id, {
        data: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "GPT-5.4",
            description: "Fake model",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "Deep" },
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            isDefault: true,
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
          },
        ],
        nextCursor: null,
      });
      return;
    }

    case "thread/start": {
      if (scenario === "resume-required" || scenario === "fork-required") {
        sendError(id, -32010, "thread/start is forbidden for this scenario", {
          category: "transport",
          adapterCode: "CODEX_TRANSPORT_ERROR",
        });
        return;
      }
      if (
        !experimentalApiCapability &&
        ("persistExtendedHistory" in params || "experimentalRawEvents" in params)
      ) {
        sendError(
          id,
          -32602,
          "thread/start.persistFullHistory requires experimentalApi capability",
          {
            category: "transport",
            adapterCode: "CODEX_PROTOCOL_ERROR",
          },
        );
        return;
      }
      threadId = "thread-1";
      sendResult(id, {
        thread: {
          id: threadId,
          turns: [],
        },
        model: params.model ?? "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: params.cwd ?? "/tmp/fake",
        instructionSources: [],
        approvalPolicy: params.approvalPolicy ?? "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: null,
      });
      sendNotification("thread/started", { threadId, thread: { id: threadId } });
      return;
    }

    case "thread/list": {
      if (scenario === "session-discovery-hang") {
        return;
      }
      sendResult(id, {
        data: [makeThread()],
        nextCursor: null,
      });
      return;
    }

    case "thread/read": {
      threadId =
        typeof params.threadId === "string" && params.threadId.trim().length > 0
          ? params.threadId.trim()
          : "thread-read";
      const turns =
        scenario === "system-error-thread-read"
          ? [
              {
                id: turnId,
                status: "failed",
                error: {
                  message: "Provider rejected the request",
                  codexErrorInfo: "unauthorized",
                  additionalDetails: "invalid API key",
                },
                items: [],
              },
            ]
          : scenario === "system-error-thread-read-nested"
            ? [
                {
                  id: turnId,
                  status: "failed",
                  error: null,
                  items: [
                    {
                      type: "diagnostic",
                      id: "item-error-1",
                      payload: {
                        error: {
                          message: "Provider rejected nested request",
                          codexErrorInfo: { unauthorized: {} },
                          additionalDetails: "nested invalid API key",
                        },
                      },
                    },
                  ],
                },
              ]
            : scenario === "system-error-thread-read-empty"
              ? []
              : params.includeTurns
                ? [
                    {
                      id: "turn-read-1",
                      status: "completed",
                      error: null,
                      items: [
                        {
                          type: "userMessage",
                          id: "item-user-1",
                          content: [
                            { type: "text", text: "Stored user prompt", text_elements: [] },
                          ],
                        },
                        {
                          type: "agentMessage",
                          id: "item-agent-1",
                          text: "Stored assistant answer",
                          phase: "final_answer",
                          memoryCitation: null,
                        },
                      ],
                    },
                  ]
                : [];
      sendResult(id, {
        thread: makeThread({
          id: threadId,
          turns,
        }),
      });
      return;
    }

    case "thread/fork": {
      threadId =
        typeof params.threadId === "string" && params.threadId.trim().length > 0
          ? `${params.threadId.trim()}-fork`
          : "thread-forked";
      sendResult(id, {
        thread: {
          id: threadId,
          turns: [],
        },
        model: params.model ?? "gpt-5.4",
        modelProvider: params.modelProvider ?? "openai",
        serviceTier: null,
        cwd: params.cwd ?? "/tmp/fake",
        instructionSources: [],
        approvalPolicy: params.approvalPolicy ?? "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: null,
      });
      return;
    }

    case "thread/resume": {
      if (!experimentalApiCapability && "persistExtendedHistory" in params) {
        sendError(
          id,
          -32602,
          "thread/resume.persistFullHistory requires experimentalApi capability",
          {
            category: "transport",
            adapterCode: "CODEX_PROTOCOL_ERROR",
          },
        );
        return;
      }
      threadId =
        typeof params.threadId === "string" && params.threadId.trim().length > 0
          ? params.threadId.trim()
          : "thread-resumed";
      sendResult(id, {
        thread: {
          id: threadId,
          turns: [],
        },
        model: params.model ?? "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: params.cwd ?? "/tmp/fake",
        instructionSources: [],
        approvalPolicy: params.approvalPolicy ?? "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: null,
      });
      return;
    }

    case "turn/start": {
      turnCounter += 1;
      turnId = `turn-${turnCounter}`;
      if (scenario === "delayed-turn-start-requires-interrupt") {
        waitingForInterrupt = true;
        setTimeout(() => {
          sendResult(id, {
            turn: makeTurn("inProgress"),
          });
          sendNotification("turn/started", {
            threadId,
            turn: makeTurn("inProgress"),
          });
          interruptFallbackTimer = setTimeout(() => {
            if (!waitingForInterrupt) {
              return;
            }
            waitingForInterrupt = false;
            completeTurn("No interrupt received", {
              inputTokens: 1,
              outputTokens: 1,
            });
          }, 250);
        }, 50);
        return;
      }

      sendResult(id, {
        turn: makeTurn("inProgress"),
      });
      sendNotification("turn/started", {
        threadId,
        turn: makeTurn("inProgress"),
      });

      if (scenario === "malformed-after-turn-start") {
        process.stdout.write("not-json\n");
        return;
      }

      if (scenario === "requires-interrupt") {
        waitingForInterrupt = true;
        interruptFallbackTimer = setTimeout(() => {
          if (!waitingForInterrupt) {
            return;
          }
          waitingForInterrupt = false;
          completeTurn("No interrupt received", {
            inputTokens: 1,
            outputTokens: 1,
          });
        }, 250);
        return;
      }

      if (scenario === "turn-failed") {
        sendNotification("turn/completed", {
          threadId,
          turn: {
            ...makeTurn("failed"),
            error: {
              message: "simulated turn failure",
              category: "transport",
              adapterCode: "CODEX_TRANSPORT_ERROR",
            },
          },
        });
        return;
      }

      if (scenario === "mcp-startup-system-error") {
        sendNotification("mcpServer/startupStatus/updated", {
          name: "filesystem",
          status: "failed",
          error: {
            message: "configured root is not readable",
          },
        });
        sendNotification("thread/status/changed", {
          threadId,
          status: { type: "systemError" },
        });
        return;
      }

      if (
        scenario === "system-error-thread-read" ||
        scenario === "system-error-thread-read-nested" ||
        scenario === "system-error-thread-read-empty"
      ) {
        sendNotification("thread/status/changed", {
          threadId,
          status: { type: "systemError" },
        });
        return;
      }

      if (scenario === "approval-request" || scenario === "approval-command-denied") {
        sendApprovalRequest("command");
        return;
      }

      if (scenario === "approval-file-change-denied") {
        sendApprovalRequest("file-change");
        return;
      }

      if (scenario === "approval-permissions-denied") {
        sendApprovalRequest("permissions");
        return;
      }

      if (scenario === "long-running-stage-success") {
        setTimeout(() => {
          completeTurn("Long running fake app-server stage finished", {
            inputTokens: 11,
            outputTokens: 7,
          });
        }, 150);
        return;
      }

      completeTurn("Hello from fake app-server", {
        inputTokens: 11,
        outputTokens: 7,
      });
      return;
    }

    case "turn/interrupt": {
      sendResult(id, {});
      if (waitingForInterrupt) {
        waitingForInterrupt = false;
        if (interruptFallbackTimer) {
          clearTimeout(interruptFallbackTimer);
          interruptFallbackTimer = null;
        }
        sendNotification("item/agentMessage/delta", {
          threadId,
          turnId,
          itemId: "item-message-1",
          delta: "Interrupted by client",
        });
        sendUsage(1, 1);
        sendNotification("turn/completed", {
          threadId,
          turn: makeTurn("interrupted"),
        });
      }
      return;
    }

    default: {
      sendError(id, -32601, `Unknown method: ${method}`);
    }
  }
}

reader.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write("failed to parse inbound JSON-RPC payload\n");
    return;
  }

  handleRequest(message);
});
