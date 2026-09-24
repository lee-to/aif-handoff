# Google Antigravity Process Tree Safety & Unit Test Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate unsafe rogue `SIGKILL` signals sent to arbitrary process PID 1234 on POSIX in Antigravity adapter unit tests, make `killProcessTree` cross-platform deterministic with Windows fallback, and establish dedicated isolated unit and live process lifecycle tests for process tree termination.

**Architecture:**

1. Unit test isolation: In `antigravityCli.test.ts`, install a safe top-level `process.kill` spy and mock implementation to ensure that wrapped `mockChild.kill()` calls during abort/timeout tests never leak `process.kill(-1234, "SIGKILL")` to the host OS.
2. Cross-platform runtime safety: Export `killProcessTree(pid, platform)` in `cli.ts` with explicit platform injection, PID sanity checks, and a fallback to `process.kill(pid, "SIGKILL")` if `taskkill` fails on Windows.
3. Isolated test suite: Introduce `antigravityProcessTree.test.ts` without file-level `node:child_process` mocking. Test deterministic execution of both Windows (`taskkill`) and POSIX (`SIGKILL`) paths via parameter injection, and verify real OS process termination on a genuine spawned Node.js process using its own PID.
4. Git branch hygiene: Cleanly commit and verify these changes on `feature/antigravity-adapter` for PR #184.

**Tech Stack:** TypeScript (ES2022, ESNext), Node.js (`node:child_process`, `node:os`), Vitest, npm workspaces (`@aif/runtime`).

**Spec:** Reviewer feedback on PR #184 commit `cf3a500` regarding [P1] rogue `SIGKILL` to PID 1234, [AGENTS.md](../../../AGENTS.md).

## Global Constraints

- Never combine shell commands with `&&`, `||`, or `;` — execute each command as a separate tool call.
- DB boundary: access database only through `@aif/data`.
- Keep `@aif/runtime` at or above 70% branch and statement test coverage.
- All code, variable names, comments, and commit messages must be in English.
- No placeholders (TODO, TBD, "implement later"); provide full executable code for every step.
- Run `npm run ai:validate` after all tasks are completed.

---

### Task 1: Intercept `process.kill` in `antigravityCli.test.ts` and Fix ESLint Warnings

**Files:**

- Modify: `packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts:1-70`, `290-430`, `590-620`
- Test: `packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts`

**Interfaces:**

- Consumes: `mockChild` with `pid: 1234` from hoisted mocks.
- Produces: Safe `mockProcessKill` spy intercepting `process.kill`, preventing signal delivery to host OS on POSIX.

- [ ] **Step 1: Add `process.kill` spy and remove unused imports in `antigravityCli.test.ts`**

In `packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts`:

1. Ensure `afterAll` is imported from `vitest`.
2. Remove any unused `killProcessTree` import from `../cli.js`.
3. Add a top-level `mockProcessKill = vi.spyOn(process, "kill").mockImplementation((() => true) as any)`.
4. In `beforeEach`, clear `mockProcessKill` and reset implementation:
   ```typescript
   mockProcessKill.mockClear();
   mockProcessKill.mockImplementation((() => true) as any);
   ```
5. In `afterAll`, restore the spy:
   ```typescript
   mockProcessKill.mockRestore();
   ```

- [ ] **Step 2: Update assertions in `antigravityCli.test.ts` for POSIX branches**

In `packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts`:

1. In `it("intercepts child.kill to terminate process tree via taskkill on Windows or process.kill on POSIX")`:
   ```typescript
   if (process.platform === "win32") {
     expect(mockSpawnSync).toHaveBeenCalledWith(
       "taskkill",
       ["/PID", "1234", "/T", "/F"],
       expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
     );
   } else {
     expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
   }
   ```
2. In `it("handles pre-aborted controller")`:
   ```typescript
   if (process.platform === "win32") {
     expect(mockSpawnSync).toHaveBeenCalledWith(
       "taskkill",
       ["/PID", "1234", "/T", "/F"],
       expect.any(Object),
     );
   } else {
     expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
   }
   ```
3. In `it("handles abortion while running")`:
   ```typescript
   if (process.platform === "win32") {
     expect(mockSpawnSync).toHaveBeenCalledWith(
       "taskkill",
       ["/PID", "1234", "/T", "/F"],
       expect.any(Object),
     );
   } else {
     expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
   }
   ```
4. In `it("ensures child.kill is idempotent and does not run killProcessTree repeatedly")`:
   ```typescript
   mockSpawnSync.mockClear();
   mockProcessKill.mockClear();
   // ...
   if (process.platform === "win32") {
     expect(mockSpawnSync).toHaveBeenCalledTimes(1);
   } else {
     expect(mockProcessKill).toHaveBeenCalledTimes(1);
     expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
   }
   ```

- [ ] **Step 3: Run the CLI unit tests and verify they pass with zero unmocked kill signals**

Run: `npm test --workspace=@aif/runtime -- packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts`
Expected: PASS with all tests passing and no ESLint warnings.

- [ ] **Step 4: Run linter on the test file**

Run: `npx eslint packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts`
Expected: 0 errors, 0 warnings.

---

### Task 2: Harden `killProcessTree` in `cli.ts` with Platform Injection & Fallback

**Files:**

- Modify: `packages/runtime/src/adapters/antigravity/cli.ts:110-140`, `490-500`
- Test: `packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts`

**Interfaces:**

- Produces: `export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void`
- Consumes: `child.stdin.write(fullPrompt, "utf8")`

- [ ] **Step 1: Update `killProcessTree` implementation in `cli.ts`**

In `packages/runtime/src/adapters/antigravity/cli.ts`, update `killProcessTree`:

```typescript
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return;
  if (platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}
```

- [ ] **Step 2: Explicitly set UTF-8 encoding on stdin prompt delivery**

In `packages/runtime/src/adapters/antigravity/cli.ts` around line 495:

```typescript
if (fullPrompt) {
  child.stdin!.write(fullPrompt, "utf8");
}
child.stdin!.end();
```

- [ ] **Step 3: Run runtime tests to verify changes**

Run: `npm test --workspace=@aif/runtime -- packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts`
Expected: PASS.

---

### Task 3: Create Dedicated Test Suite `antigravityProcessTree.test.ts`

**Files:**

- Create: `packages/runtime/src/adapters/antigravity/__tests__/antigravityProcessTree.test.ts`
- Test: `packages/runtime/src/adapters/antigravity/__tests__/antigravityProcessTree.test.ts`

**Interfaces:**

- Consumes: `killProcessTree` from `../cli.js`
- Tests: Cross-platform behavior with platform parameter injection and a live child process spawned without mocks.

- [ ] **Step 1: Write `antigravityProcessTree.test.ts` with deterministic unit tests and real process test**

Create `packages/runtime/src/adapters/antigravity/__tests__/antigravityProcessTree.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import * as childProcess from "node:child_process";
import { killProcessTree } from "../cli.js";

describe("killProcessTree Unit & Integration Tests", () => {
  let mockProcessKill: ReturnType<typeof vi.spyOn>;
  let mockSpawnSync: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockProcessKill = vi.spyOn(process, "kill").mockImplementation((() => true) as any);
    mockSpawnSync = vi.spyOn(childProcess, "spawnSync").mockImplementation((() => ({})) as any);
  });

  afterEach(() => {
    mockProcessKill.mockRestore();
    mockSpawnSync.mockRestore();
  });

  describe("Unit tests with mock process targets", () => {
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

    it("ignores non-positive or invalid PIDs safely without system calls", () => {
      killProcessTree(0, "linux");
      killProcessTree(-10, "linux");
      killProcessTree(NaN, "linux");
      killProcessTree(null as any, "win32");
      killProcessTree(undefined as any, "win32");

      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(mockProcessKill).not.toHaveBeenCalled();
    });
  });

  describe("Real OS Process Tree Cleanup", () => {
    it("terminates a real spawned child process using its genuine PID", async () => {
      mockProcessKill.mockRestore();
      mockSpawnSync.mockRestore();

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

      killProcessTree(pid);

      const exitResult = await Promise.race([
        exitPromise,
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout waiting for process to exit")), 5000),
        ),
      ]);

      expect(exitResult).not.toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the new process tree test suite**

Run: `npm test --workspace=@aif/runtime -- packages/runtime/src/adapters/antigravity/__tests__/antigravityProcessTree.test.ts`
Expected: PASS (all 7 tests pass, including the live child process cleanup test).

---

### Task 4: Target Branch Alignment and PR #184 Verification

**Files:**

- Modify: `feature/antigravity-adapter` branch
- Verify: Full test suite and linter on `@aif/runtime`

- [ ] **Step 1: Check git branch and apply changes to `feature/antigravity-adapter`**

1. Switch to `feature/antigravity-adapter`:
   ```bash
   git checkout feature/antigravity-adapter
   ```
2. Verify unstaged or committed changes are applied to `packages/runtime/src/adapters/antigravity/cli.ts`, `packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts`, and `packages/runtime/src/adapters/antigravity/__tests__/antigravityProcessTree.test.ts`.

- [ ] **Step 2: Run the full adapter test suite on `feature/antigravity-adapter`**

Run: `npm test --workspace=@aif/runtime -- antigravity bootstrap timeoutCoverage`
Expected: All tests pass (>= 102 passed, 7 skipped).

- [ ] **Step 3: Run the linter on `@aif/runtime`**

Run: `npm run lint --workspace=@aif/runtime`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit changes on `feature/antigravity-adapter`**

```bash
git add packages/runtime/src/adapters/antigravity/cli.ts packages/runtime/src/adapters/antigravity/__tests__/antigravityCli.test.ts packages/runtime/src/adapters/antigravity/__tests__/antigravityProcessTree.test.ts
git commit -m "fix(runtime/antigravity): isolate process.kill in unit tests and add dedicated process tree suite"
```

- [ ] **Step 5: Run AI validation suite**

Run: `npm run ai:validate`
Expected: PASS across all checks.
