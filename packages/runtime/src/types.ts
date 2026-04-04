export type RuntimeTransport = "sdk" | "cli" | "http" | "agentapi" | string;

export interface RuntimeCapabilities {
  supportsResume: boolean;
  supportsSessionList: boolean;
  supportsAgentDefinitions: boolean;
  supportsStreaming: boolean;
  supportsModelDiscovery: boolean;
  supportsApprovals: boolean;
  supportsCustomEndpoint: boolean;
}

export const DEFAULT_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: false,
  supportsModelDiscovery: false,
  supportsApprovals: false,
  supportsCustomEndpoint: false,
};

export interface RuntimeDescriptor {
  id: string;
  providerId: string;
  displayName: string;
  description?: string;
  version?: string;
  defaultTransport?: RuntimeTransport;
  capabilities: RuntimeCapabilities;
}

export interface RuntimeRunInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  workflowKind?: string;
  transport?: RuntimeTransport;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  sessionId?: string | null;
  resume?: boolean;
  stream?: boolean;
  projectId?: string;
  projectRoot?: string;
  cwd?: string;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RuntimeEvent {
  type: string;
  timestamp: string;
  level?: "debug" | "info" | "warn" | "error";
  message?: string;
  data?: Record<string, unknown>;
}

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface RuntimeSession {
  id: string;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  model?: string | null;
  title?: string | null;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeRunResult {
  outputText?: string;
  sessionId?: string | null;
  session?: RuntimeSession | null;
  events?: RuntimeEvent[];
  usage?: RuntimeUsage | null;
  raw?: unknown;
}

export interface RuntimeSessionListInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  projectRoot?: string;
  limit?: number;
}

export interface RuntimeSessionGetInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  projectRoot?: string;
  sessionId: string;
}

export interface RuntimeSessionEventsInput extends RuntimeSessionGetInput {
  limit?: number;
}

export interface RuntimeConnectionValidationInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  model?: string;
  transport?: RuntimeTransport;
  options?: Record<string, unknown>;
}

export interface RuntimeConnectionValidationResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeModel {
  id: string;
  label?: string;
  supportsStreaming?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RuntimeModelListInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  projectRoot?: string;
}

export interface RuntimeAdapter {
  descriptor: RuntimeDescriptor;
  run(input: RuntimeRunInput): Promise<RuntimeRunResult>;
  resume?(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult>;
  listSessions?(input: RuntimeSessionListInput): Promise<RuntimeSession[]>;
  getSession?(input: RuntimeSessionGetInput): Promise<RuntimeSession | null>;
  listSessionEvents?(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]>;
  validateConnection?(
    input: RuntimeConnectionValidationInput,
  ): Promise<RuntimeConnectionValidationResult>;
  listModels?(input: RuntimeModelListInput): Promise<RuntimeModel[]>;
}
