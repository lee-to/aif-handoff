import { spawn } from "node:child_process";

export interface ClaudeStderrCollector {
  onStderr: (chunk: string) => void;
  getTail: () => string;
}

export function createClaudeStderrCollector(maxLines = 20): ClaudeStderrCollector {
  const lines: string[] = [];

  return {
    onStderr: (chunk: string) => {
      for (const rawLine of chunk.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    getTail: () => lines.join(" | "),
  };
}

export function explainClaudeFailure(err: unknown, stderrTail: string): string {
  const baseMessage = err instanceof Error ? err.message : String(err);
  const stderr = stderrTail.trim();
  const combinedLower = `${baseMessage} ${stderr}`.toLowerCase();

  if (combinedLower.includes("not logged in") || combinedLower.includes("/login")) {
    return `Claude not logged in. Run claude /login. ${stderr || baseMessage}`;
  }

  if (
    combinedLower.includes("rate limit") ||
    combinedLower.includes("usage limit") ||
    combinedLower.includes("extra usage") ||
    combinedLower.includes("out of extra usage") ||
    combinedLower.includes("quota") ||
    combinedLower.includes("credits")
  ) {
    return `Claude usage limit reached. ${stderr || baseMessage}`;
  }

  if (combinedLower.includes("stream closed") || combinedLower.includes("error in hook callback")) {
    return `Claude stream interrupted during execution. ${stderr || baseMessage}`;
  }

  if (stderr) {
    return `${baseMessage}. Claude stderr: ${stderr}`;
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

export async function probeClaudeCliFailure(
  projectRoot: string,
  claudePath?: string,
): Promise<string> {
  const cmd = claudePath || "claude";
  const args = ["-p", "Reply with OK only", "--output-format", "text"];

  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve(`Failed to execute Claude CLI: ${err.message}`);
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve("Timed out while probing Claude CLI");
    }, 15000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve("");
        return;
      }

      const merged = [stderr, stdout].filter(Boolean).join("\n");
      resolve(trimForLog(merged || `Claude CLI exited with code ${code}`));
    });
  });
}
