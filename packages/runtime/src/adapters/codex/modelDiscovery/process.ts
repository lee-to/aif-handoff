import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { RuntimeTransport, type RuntimeModelListInput } from "../../../types.js";
import type { AppServerLaunchContext } from "./types.js";

const IS_WINDOWS = process.platform === "win32";
const moduleRequire = createRequire(import.meta.url);
const CODEX_SDK_NPM_NAME = "@openai/codex-sdk";
const CODEX_NPM_NAME = "@openai/codex";
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

const ALLOWED_ENV_PREFIXES = [
  "OPENAI_",
  "CODEX_",
  "AIF_",
  "HANDOFF_",
  "NODE_",
  "HOME",
  "USER",
  "LANG",
  "LC_",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_",
  "FORCE_COLOR",
  "NO_COLOR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];
const BLOCKED_ENV_KEYS = new Set(["OPENAI_BASE_URL"]);

export function resolveDiscoveryExecutable(input: RuntimeModelListInput): string {
  const options = asRecord(input.options);
  const configuredCliPath =
    readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH);

  if (configuredCliPath) {
    return configuredCliPath;
  }

  if (input.transport === RuntimeTransport.SDK) {
    return findBundledCodexBinary();
  }

  return "codex";
}

export function buildCodexAppServerDiscoveryEnv(
  input: RuntimeModelListInput,
): Record<string, string> {
  return buildCodexAppServerDiscoveryEnvWithStats(input).env;
}

export function buildCodexAppServerDiscoveryEnvWithStats(input: RuntimeModelListInput): {
  env: Record<string, string>;
  forwardedCount: number;
  filteredCount: number;
  blockedCount: number;
  droppedDisallowedPrefixKeys: string[];
} {
  const env: Record<string, string> = {};
  let forwardedCount = 0;
  let filteredCount = 0;
  let blockedCount = 0;
  const droppedDisallowedPrefixKeys = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (BLOCKED_ENV_KEYS.has(key)) {
      blockedCount += 1;
      continue;
    }
    if (ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))) {
      env[key] = value;
      forwardedCount += 1;
    } else {
      filteredCount += 1;
      if (key.startsWith("npm_")) {
        droppedDisallowedPrefixKeys.add(key);
      }
    }
  }

  const options = asRecord(input.options);
  const apiKeyEnvVar =
    readString(options.apiKeyEnvVar) ?? readString(input.apiKeyEnvVar) ?? "OPENAI_API_KEY";
  const apiKey =
    readString(input.apiKey) ??
    readString(options.apiKey) ??
    readString(process.env[apiKeyEnvVar]) ??
    readString(process.env.OPENAI_API_KEY);
  if (apiKey) {
    env[apiKeyEnvVar] = apiKey;
    env.OPENAI_API_KEY = apiKey;
  }

  const baseUrl =
    readString(input.baseUrl) ??
    readString(options.baseUrl) ??
    readString(process.env.CODEX_BASE_URL);
  if (baseUrl) {
    env.CODEX_BASE_URL = baseUrl;
  }

  return {
    env,
    forwardedCount,
    filteredCount,
    blockedCount,
    droppedDisallowedPrefixKeys: [...droppedDisallowedPrefixKeys],
  };
}

export async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve loopback port for Codex app-server"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export function spawnCodexAppServer(
  executablePath: string,
  listenUrl: string,
  cwd: string | undefined,
  env: Record<string, string>,
): AppServerLaunchContext {
  const args = ["app-server", "--listen", listenUrl];
  const childProcess =
    IS_WINDOWS && !executablePath.toLowerCase().endsWith(".exe")
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", [executablePath, ...args].map(quoteIfNeeded).join(" ")],
          {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsVerbatimArguments: true,
          },
        )
      : spawn(executablePath, args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

  const stderr: string[] = [];
  childProcess.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(String(chunk));
    if (stderr.length > 25) {
      stderr.shift();
    }
  });

  return { process: childProcess, stderr };
}

export function terminateProcess(process: ChildProcess): void {
  if (process.exitCode != null) {
    return;
  }

  try {
    process.kill();
  } catch {
    // ignored
  }
}

function findBundledCodexBinary(): string {
  const { platform, arch } = process;
  let targetTriple: string | null = null;

  switch (platform) {
    case "linux":
    case "android":
      targetTriple =
        arch === "x64"
          ? "x86_64-unknown-linux-musl"
          : arch === "arm64"
            ? "aarch64-unknown-linux-musl"
            : null;
      break;
    case "darwin":
      targetTriple =
        arch === "x64" ? "x86_64-apple-darwin" : arch === "arm64" ? "aarch64-apple-darwin" : null;
      break;
    case "win32":
      targetTriple =
        arch === "x64"
          ? "x86_64-pc-windows-msvc"
          : arch === "arm64"
            ? "aarch64-pc-windows-msvc"
            : null;
      break;
    default:
      targetTriple = null;
  }

  if (!targetTriple) {
    throw new Error(`Unsupported platform for bundled Codex binary: ${platform} (${arch})`);
  }

  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) {
    throw new Error(`Unsupported Codex target triple: ${targetTriple}`);
  }

  const codexSdkPackageJsonPath = moduleRequire.resolve(`${CODEX_SDK_NPM_NAME}/package.json`);
  const codexSdkRequire = createRequire(codexSdkPackageJsonPath);
  const codexPackageJsonPath = codexSdkRequire.resolve(`${CODEX_NPM_NAME}/package.json`);
  const codexRequire = createRequire(codexPackageJsonPath);
  const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
  const vendorRoot = path.join(path.dirname(platformPackageJsonPath), "vendor");
  const binaryName = IS_WINDOWS ? "codex.exe" : "codex";
  return path.join(vendorRoot, targetTriple, "codex", binaryName);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function quoteIfNeeded(arg: string): string {
  return arg.includes(" ") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
