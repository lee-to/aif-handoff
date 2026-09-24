import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { killProcessTree } from "../cli.js";

const { mockSpawnSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: any[]) => {
      if (mockSpawnSync.getMockImplementation()) {
        return mockSpawnSync(...args);
      }
      return (actual.spawnSync as any)(...args);
    },
  };
});

describe("killProcessTree Unit & Integration Tests", () => {
  describe("Unit tests with mock process targets", () => {
    let mockProcessKill: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockProcessKill = vi.spyOn(process, "kill").mockImplementation((() => true) as any);
      mockSpawnSync.mockReset();
      mockSpawnSync.mockImplementation((() => ({ status: 0 })) as any);
    });

    afterEach(() => {
      mockProcessKill.mockRestore();
      mockSpawnSync.mockReset();
    });

    it("terminates process tree via taskkill on win32", () => {
      killProcessTree(1234, "win32");

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "1234", "/T", "/F"],
        expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
      );
      expect(mockProcessKill).not.toHaveBeenCalled();
    });

    it("falls back to process.kill on win32 if taskkill throws", () => {
      mockSpawnSync.mockImplementation(() => {
        throw new Error("taskkill not found");
      });

      killProcessTree(1234, "win32");

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "1234", "/T", "/F"],
        expect.any(Object),
      );
      expect(mockProcessKill).toHaveBeenCalledWith(1234, "SIGKILL");
    });

    it("falls back to process.kill on win32 if taskkill returns spawn error", () => {
      mockSpawnSync.mockImplementation(
        () =>
          ({
            error: new Error("spawnSync taskkill ENOENT"),
            status: null,
          }) as any,
      );

      killProcessTree(1234, "win32");

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "1234", "/T", "/F"],
        expect.any(Object),
      );
      expect(mockProcessKill).toHaveBeenCalledWith(1234, "SIGKILL");
    });

    it("falls back to process.kill on win32 if taskkill exits with non-zero status", () => {
      mockSpawnSync.mockImplementation(
        () =>
          ({
            status: 1,
          }) as any,
      );

      killProcessTree(1234, "win32");

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "1234", "/T", "/F"],
        expect.any(Object),
      );
      expect(mockProcessKill).toHaveBeenCalledWith(1234, "SIGKILL");
    });

    it("falls back to process.kill on win32 if taskkill terminates due to signal (status: null)", () => {
      mockSpawnSync.mockImplementation(
        () =>
          ({
            status: null,
            signal: "SIGTERM",
          }) as any,
      );

      killProcessTree(1234, "win32");

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "1234", "/T", "/F"],
        expect.any(Object),
      );
      expect(mockProcessKill).toHaveBeenCalledWith(1234, "SIGKILL");
    });

    it("terminates process group on POSIX (linux)", () => {
      killProcessTree(1234, "linux");

      expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it("terminates process group on POSIX (darwin)", () => {
      killProcessTree(1234, "darwin");

      expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it("falls back to single PID on POSIX if group kill fails", () => {
      mockProcessKill.mockImplementation(((pid: number) => {
        if (pid < 0) throw new Error("ESRCH");
        return true;
      }) as any);

      killProcessTree(1234, "linux");

      expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
      expect(mockProcessKill).toHaveBeenCalledWith(1234, "SIGKILL");
    });

    it("safely swallows ESRCH if process has already terminated on POSIX", () => {
      mockProcessKill.mockImplementation((() => {
        throw new Error("ESRCH: no such process");
      }) as any);

      expect(() => killProcessTree(1234, "linux")).not.toThrow();
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
      expect(mockProcessKill).toHaveBeenCalledWith(1234, "SIGKILL");
    });

    it("safely swallows ESRCH if process has already terminated on win32 fallback", () => {
      mockSpawnSync.mockImplementation(() => ({ status: 1 }) as any);
      mockProcessKill.mockImplementation((() => {
        throw new Error("ESRCH: no such process");
      }) as any);

      expect(() => killProcessTree(1234, "win32")).not.toThrow();
      expect(mockProcessKill).toHaveBeenCalledWith(1234, "SIGKILL");
    });

    it("ignores non-positive, non-integer, or invalid PIDs safely without system calls (including PID 1 init protection)", () => {
      killProcessTree(0, "linux");
      killProcessTree(1, "linux"); // PID 1 init protection against kill(-1)
      killProcessTree(1, "win32");
      killProcessTree(-10, "linux");
      killProcessTree(NaN, "linux");
      killProcessTree(1.5, "linux");
      killProcessTree(null as any, "win32");
      killProcessTree(undefined as any, "win32");

      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(mockProcessKill).not.toHaveBeenCalled();
    });
  });

  describe("Real OS Process Tree Cleanup", () => {
    it("terminates a real spawned child process using its genuine PID", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: process.platform !== "win32",
        stdio: "ignore",
      });

      expect(child.pid).toBeDefined();
      const pid = child.pid!;
      expect(pid).toBeGreaterThan(0);

      const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.on("exit", (code, signal) => {
          resolve({ code, signal });
        });
      });

      try {
        killProcessTree(pid);

        const exitResult = await Promise.race([
          exitPromise,
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error("Timeout waiting for process to exit")), 5000),
          ),
        ]);

        expect(exitResult).not.toBeNull();
      } finally {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        } catch {
          // ignore cleanup errors
        }
      }
    });

    it("terminates an entire real process tree (parent and child) using parent PID", async () => {
      const code = `
        const { spawn } = require("node:child_process");
        const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        console.log(sub.pid);
        setInterval(() => {}, 1000);
      `;
      const parent = spawn(process.execPath, ["-e", code], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "ignore"],
      });

      expect(parent.pid).toBeDefined();
      const parentPid = parent.pid!;

      let subPid: number | null = null;
      const subPidPromise = new Promise<number>((resolve) => {
        parent.stdout!.on("data", (chunk: Buffer | string) => {
          const text = chunk.toString().trim();
          const parsed = parseInt(text, 10);
          if (Number.isInteger(parsed) && parsed > 0) {
            resolve(parsed);
          }
        });
      });

      const parentExitPromise = new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
          parent.on("exit", (code, signal) => {
            resolve({ code, signal });
          });
        },
      );

      try {
        subPid = await Promise.race([
          subPidPromise,
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error("Timeout waiting for subchild spawn")), 5000),
          ),
        ]);

        expect(subPid).toBeGreaterThan(0);

        killProcessTree(parentPid);

        const exitResult = await Promise.race([
          parentExitPromise,
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error("Timeout waiting for parent process to exit")), 5000),
          ),
        ]);

        expect(exitResult).not.toBeNull();

        // Deep verification: assert that the descendant child process (subPid) was terminated by killProcessTree
        await vi.waitFor(
          () => {
            let isSubAlive = true;
            try {
              process.kill(subPid!, 0);
            } catch (err: any) {
              if (err.code === "ESRCH") {
                isSubAlive = false;
              }
            }
            expect(isSubAlive).toBe(false);
          },
          { timeout: 5000, interval: 50 },
        );
      } finally {
        try {
          if (parent.exitCode === null && parent.signalCode === null) {
            parent.kill("SIGKILL");
          }
        } catch {
          // ignore cleanup errors
        }
        if (subPid) {
          try {
            process.kill(subPid, "SIGKILL");
          } catch {
            // ignore cleanup errors
          }
        }
      }
    });
  });
});
