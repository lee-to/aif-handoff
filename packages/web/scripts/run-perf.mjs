import { spawn } from "node:child_process";
import { once } from "node:events";

const READY_URL = process.env.AIF_WEB_URL ?? "http://localhost:5180";
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function spawnInherited(command, args, options = {}) {
  return spawn(commandName(command), args, {
    stdio: "inherit",
    ...options,
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

async function waitForReady(child) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`dev:perf exited before ${READY_URL} became ready`);
    }

    try {
      const response = await fetch(READY_URL, { method: "HEAD" });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // Server is still booting.
    }

    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  throw new Error(`Timed out waiting ${READY_TIMEOUT_MS}ms for ${READY_URL}`);
}

function stopDevServer(child) {
  if (child.exitCode !== null) return;

  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM");
      return;
    }
    child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function run() {
  const dev = spawnInherited("npm", ["run", "dev:perf", "--prefix", "../.."], {
    detached: process.platform !== "win32",
    env: { AIF_ENABLE_CODEX_LOGIN_PROXY: "false" },
  });

  const devExit = once(dev, "exit").then(([code, signal]) => ({ code, signal }));

  try {
    await waitForReady(dev);

    const perf = spawnInherited("playwright", ["test", "--config=playwright.config.ts"], {
      env: { AIF_SKIP_DEV_SERVER: "1" },
    });
    const [code, signal] = await once(perf, "exit");
    if (code !== 0) {
      throw new Error(`playwright exited with ${code ?? signal}`);
    }
  } finally {
    stopDevServer(dev);
    await Promise.race([devExit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
