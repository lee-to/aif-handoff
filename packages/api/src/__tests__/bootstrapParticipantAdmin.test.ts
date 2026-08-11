import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Participant } from "@aif/shared";
import {
  bootstrapFirstParticipantAdmin,
  parseBootstrapArguments,
  readProtectedPasswordFile,
  type BootstrapDependencies,
} from "../scripts/bootstrapParticipantAdmin.js";

const existingAdmin: Participant = {
  id: "admin-id",
  username: "admin",
  displayName: "Admin",
  role: "admin",
  active: true,
  deactivatedAt: null,
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
};

function createDependencies(
  overrides: Partial<BootstrapDependencies> = {},
): BootstrapDependencies & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    countParticipants: vi.fn(() => 0),
    findParticipantByUsername: vi.fn(() => null),
    createParticipant: vi.fn(async () => ({
      ok: true as const,
      participant: existingAdmin,
    })),
    readPasswordFile: vi.fn(() => "protected bootstrap password\n"),
    readPasswordStdin: vi.fn(() => "protected bootstrap password\n"),
    isInteractiveTerminal: vi.fn(() => true),
    promptInteractive: vi.fn(async () => ({
      username: "admin",
      displayName: "Admin",
      password: "protected bootstrap password",
      passwordConfirmation: "protected bootstrap password",
    })),
    writeOutput: (message) => output.push(message),
    writeError: (message) => errors.push(message),
    ...overrides,
    output,
    errors,
  };
}

describe("first participant administrator bootstrap", () => {
  it("selects interactive prompts when no arguments are provided", () => {
    expect(parseBootstrapArguments([])).toEqual({ interactive: true });
  });

  it("rejects password arguments and requires exactly one protected input source", () => {
    expect(() =>
      parseBootstrapArguments([
        "--username",
        "admin",
        "--display-name",
        "Admin",
        "--password=secret-value",
      ]),
    ).toThrow("Password arguments are forbidden");
    expect(() =>
      parseBootstrapArguments([
        "--username",
        "admin",
        "--display-name",
        "Admin",
        "--password-file",
        "/secret",
        "--password-stdin",
      ]),
    ).toThrow("exactly one");
  });

  it("creates the first admin from stdin without emitting the password", async () => {
    const dependencies = createDependencies();
    const password = "protected bootstrap password";
    const code = await bootstrapFirstParticipantAdmin(
      ["--username", "admin", "--display-name", "Admin", "--password-stdin"],
      dependencies,
    );

    expect(code).toBe(0);
    expect(dependencies.createParticipant).toHaveBeenCalledWith({
      username: "admin",
      displayName: "Admin",
      password,
      role: "admin",
    });
    expect(dependencies.output.join("\n")).toContain(existingAdmin.id);
    expect(dependencies.output.join("\n")).not.toContain(password);
    expect(dependencies.errors.join("\n")).not.toContain(password);
  });

  it("creates the first admin from hidden interactive prompts", async () => {
    const dependencies = createDependencies();
    const code = await bootstrapFirstParticipantAdmin([], dependencies);

    expect(code).toBe(0);
    expect(dependencies.promptInteractive).toHaveBeenCalledTimes(1);
    expect(dependencies.readPasswordFile).not.toHaveBeenCalled();
    expect(dependencies.readPasswordStdin).not.toHaveBeenCalled();
    expect(dependencies.createParticipant).toHaveBeenCalledWith({
      username: "admin",
      displayName: "Admin",
      password: "protected bootstrap password",
      role: "admin",
    });
  });

  it("flushes pending terminal output before showing interactive prompts", async () => {
    const events: string[] = [];
    const pendingOutput = new Promise<void>((resolve) => {
      setImmediate(() => {
        events.push("warning");
        resolve();
      });
    });
    const dependencies = createDependencies({
      promptInteractive: vi.fn(async () => {
        events.push("prompt");
        return {
          username: "admin",
          displayName: "Admin",
          password: "protected bootstrap password",
          passwordConfirmation: "protected bootstrap password",
        };
      }),
    });

    const bootstrap = bootstrapFirstParticipantAdmin([], dependencies);
    await Promise.all([pendingOutput, bootstrap]);

    expect(events).toEqual(["warning", "prompt"]);
  });

  it("refuses interactive input without a terminal", async () => {
    const dependencies = createDependencies({
      isInteractiveTerminal: vi.fn(() => false),
    });
    const code = await bootstrapFirstParticipantAdmin([], dependencies);

    expect(code).toBe(2);
    expect(dependencies.countParticipants).not.toHaveBeenCalled();
    expect(dependencies.promptInteractive).not.toHaveBeenCalled();
    expect(dependencies.errors.join("\n")).toContain("requires a terminal");
  });

  it("refuses mismatched interactive passwords without persisting", async () => {
    const dependencies = createDependencies({
      promptInteractive: vi.fn(async () => ({
        username: "admin",
        displayName: "Admin",
        password: "protected bootstrap password",
        passwordConfirmation: "different protected password",
      })),
    });
    const code = await bootstrapFirstParticipantAdmin([], dependencies);

    expect(code).toBe(2);
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
    expect(dependencies.errors).toEqual(["Passwords do not match."]);
  });

  it("does not prompt when participant accounts already exist", async () => {
    const dependencies = createDependencies({
      countParticipants: vi.fn(() => 1),
    });
    const code = await bootstrapFirstParticipantAdmin([], dependencies);

    expect(code).toBe(1);
    expect(dependencies.promptInteractive).not.toHaveBeenCalled();
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
  });

  it("is idempotent for the same active admin without reading a secret", async () => {
    const dependencies = createDependencies({
      countParticipants: vi.fn(() => 1),
      findParticipantByUsername: vi.fn(() => existingAdmin),
    });
    const code = await bootstrapFirstParticipantAdmin(
      ["--username", "admin", "--display-name", "Admin", "--password-file", "/unused"],
      dependencies,
    );

    expect(code).toBe(0);
    expect(dependencies.readPasswordFile).not.toHaveBeenCalled();
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
  });

  it("refuses bootstrap when a different account already exists", async () => {
    const dependencies = createDependencies({
      countParticipants: vi.fn(() => 1),
      findParticipantByUsername: vi.fn(() => null),
    });
    const code = await bootstrapFirstParticipantAdmin(
      ["--username", "another-admin", "--display-name", "Another Admin", "--password-stdin"],
      dependencies,
    );

    expect(code).toBe(1);
    expect(dependencies.readPasswordStdin).not.toHaveBeenCalled();
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
    expect(dependencies.errors.join("\n")).toContain("accounts already exist");
  });

  it("rejects short passwords without persisting them", async () => {
    const dependencies = createDependencies({
      readPasswordStdin: vi.fn(() => "too-short\n"),
    });
    const code = await bootstrapFirstParticipantAdmin(
      ["--username", "admin", "--display-name", "Admin", "--password-stdin"],
      dependencies,
    );

    expect(code).toBe(2);
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
    expect(dependencies.errors.join("\n")).not.toContain("too-short");
  });

  it("reads only regular password files with owner-only permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "aif-bootstrap-"));
    const passwordFile = join(directory, "password");
    writeFileSync(passwordFile, "protected bootstrap password\n", { mode: 0o600 });
    chmodSync(passwordFile, 0o600);
    expect(readProtectedPasswordFile(passwordFile)).toBe("protected bootstrap password\n");

    chmodSync(passwordFile, 0o644);
    expect(() => readProtectedPasswordFile(passwordFile)).toThrow(
      "must not be accessible by group or other users",
    );
    expect(() => readProtectedPasswordFile(directory)).toThrow("must be a regular file");
  });
});
