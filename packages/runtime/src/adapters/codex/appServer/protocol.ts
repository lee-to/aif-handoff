import type { ClientNotification } from "./generated/ClientNotification.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { ServerRequest } from "./generated/ServerRequest.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { ThreadListParams } from "./generated/v2/ThreadListParams.js";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse.js";
import type { ThreadForkParams } from "./generated/v2/ThreadForkParams.js";
import type { ThreadForkResponse } from "./generated/v2/ThreadForkResponse.js";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams.js";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequestEnvelope {
  id: number | string;
  method: string;
  params?: unknown;
  jsonrpc?: "2.0";
}

export interface JsonRpcNotificationEnvelope {
  method: string;
  params?: unknown;
  jsonrpc?: "2.0";
}

export interface JsonRpcSuccessEnvelope {
  id: number | string | null;
  result: unknown;
  jsonrpc?: "2.0";
}

export interface JsonRpcErrorEnvelope {
  id: number | string | null;
  error: JsonRpcErrorObject;
  jsonrpc?: "2.0";
}

export type CodexAppServerNotification = ServerNotification | ClientNotification;
export type CodexAppServerServerRequest = ServerRequest;

export const CodexAppServerMethod = {
  INITIALIZE: "initialize",
  MODEL_LIST: "model/list",
  THREAD_LIST: "thread/list",
  THREAD_FORK: "thread/fork",
  THREAD_READ: "thread/read",
  THREAD_START: "thread/start",
  THREAD_RESUME: "thread/resume",
  TURN_START: "turn/start",
  TURN_INTERRUPT: "turn/interrupt",
} as const;

export type CodexAppServerMethod = (typeof CodexAppServerMethod)[keyof typeof CodexAppServerMethod];

export type CodexAppServerRequestMap = {
  [CodexAppServerMethod.INITIALIZE]: {
    params: InitializeParams;
    result: InitializeResponse;
  };
  [CodexAppServerMethod.MODEL_LIST]: {
    params: ModelListParams;
    result: ModelListResponse;
  };
  [CodexAppServerMethod.THREAD_LIST]: {
    params: ThreadListParams;
    result: ThreadListResponse;
  };
  [CodexAppServerMethod.THREAD_FORK]: {
    params: ThreadForkParams;
    result: ThreadForkResponse;
  };
  [CodexAppServerMethod.THREAD_READ]: {
    params: ThreadReadParams;
    result: ThreadReadResponse;
  };
  [CodexAppServerMethod.THREAD_START]: {
    params: ThreadStartParams;
    result: ThreadStartResponse;
  };
  [CodexAppServerMethod.THREAD_RESUME]: {
    params: ThreadResumeParams;
    result: ThreadResumeResponse;
  };
  [CodexAppServerMethod.TURN_START]: {
    params: TurnStartParams;
    result: TurnStartResponse;
  };
  [CodexAppServerMethod.TURN_INTERRUPT]: {
    params: TurnInterruptParams;
    result: TurnInterruptResponse;
  };
};
