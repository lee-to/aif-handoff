import { spawn } from "node:child_process";
import type { RuntimeDiagnoseErrorInput } from "../../types.js";
import { RuntimeExecutionError } from "../../errors.js";

function messageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function explainFailure(err: unknown, stderrTail: string): string {
  const baseMessage = messageFromUnknown(err);
  const stderr = stderrTail.trim();
  const detail = stderr || baseMessage;

  // Primary: dispatch on structured category when available
  if (err instanceof RuntimeExecutionError && err.category !== "unknown") {
    switch (err.category) {
      case "auth":
        return `Runtime not logged in or authentication failed. Run claude /login. ${detail}`;
      case "rate_limit":
        return `Runtime usage limit reached. ${detail}`;
      case "stream":
        return `Runtime stream interrupted during execution. ${detail}`;
      case "timeout":
        return `Runtime request timed out. ${detail}`;
      case "permission":
        return `Runtime permission denied. ${detail}`;
      case "transport":
        return `Runtime connection failed. ${detail}`;
    }
  }

  // Fallback: string matching for unclassified errors or plain Error instances
  // (e.g., CLI stderr output, non-RuntimeExecutionError exceptions)
  const combinedLower = `${baseMessage} ${stderr}`.toLowerCase();

  if (combinedLower.includes("not logged in") || combinedLower.includes("/login")) {
    return `Runtime not logged in. Run claude /login. ${detail}`;
  }

  if (
    combinedLower.includes("rate limit") ||
    combinedLower.includes("usage limit") ||
    combinedLower.includes("extra usage") ||
    combinedLower.includes("out of extra usage") ||
    combinedLower.includes("quota") ||
    combinedLower.includes("credits")
  ) {
    return `Runtime usage limit reached. ${detail}`;
  }

  if (combinedLower.includes("stream closed") || combinedLower.includes("error in hook callback")) {
    return `Runtime stream interrupted during execution. ${detail}`;
  }

  if (stderr) {
    return `${baseMessage}. Runtime stderr: ${stderr}`;
  }

  if (baseMessage.toLowerCase().includes("exited with code 1")) {
    return `${baseMessage}. No stderr/stdout details from SDK; likely auth or usage-limit issue`;
  }

  return baseMessage;
}

function trimForLog(text: string, maxLen = 1200): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

async function probeCliHealth(projectRoot: string, cliPath: string): Promise<string> {
  const cmd = cliPath || "claude";
  const args = ["-p", "Reply with OK only", "--output-format", "text"];

  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve(`Failed to execute CLI: ${err.message}`);
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve("Timed out while probing CLI");
    }, 15000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve("");
        return;
      }

      const merged = [stderr, stdout].filter(Boolean).join("\n");
      resolve(trimForLog(merged || `CLI exited with code ${code}`));
    });
  });
}

export async function diagnoseClaudeError(
  input: RuntimeDiagnoseErrorInput,
  cliPath?: string,
): Promise<string> {
  let detail = input.stderrTail?.trim() ?? "";
  if (!detail && input.projectRoot) {
    detail = await probeCliHealth(input.projectRoot, cliPath ?? "claude");
  }
  return explainFailure(input.error, detail);
}
