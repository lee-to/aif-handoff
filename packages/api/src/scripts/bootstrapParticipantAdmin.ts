import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { countParticipants, createParticipant, findParticipantByUsername } from "@aif/data";
import { logger } from "@aif/shared";

const log = logger("participant-bootstrap");

interface ProtectedBootstrapOptions {
  interactive: false;
  username: string;
  displayName: string;
  passwordFile: string | null;
  passwordStdin: boolean;
}

interface InteractiveBootstrapOptions {
  interactive: true;
}

type BootstrapOptions = ProtectedBootstrapOptions | InteractiveBootstrapOptions;

interface InteractiveBootstrapInput {
  username: string;
  displayName: string;
  password: string;
  passwordConfirmation: string;
}

export interface BootstrapDependencies {
  countParticipants: typeof countParticipants;
  createParticipant: typeof createParticipant;
  findParticipantByUsername: typeof findParticipantByUsername;
  readPasswordFile(path: string): string;
  readPasswordStdin(): string;
  isInteractiveTerminal(): boolean;
  promptInteractive(): Promise<InteractiveBootstrapInput>;
  writeOutput(message: string): void;
  writeError(message: string): void;
}

const defaultDependencies: BootstrapDependencies = {
  countParticipants,
  createParticipant,
  findParticipantByUsername,
  readPasswordFile: readProtectedPasswordFile,
  readPasswordStdin() {
    return readFileSync(0, "utf8");
  },
  isInteractiveTerminal() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  },
  promptInteractive: promptInteractiveBootstrap,
  writeOutput(message) {
    process.stdout.write(`${message}\n`);
  },
  writeError(message) {
    process.stderr.write(`${message}\n`);
  },
};

async function promptInteractiveBootstrap(): Promise<InteractiveBootstrapInput> {
  let hideInput = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hideInput) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output,
    terminal: true,
    historySize: 0,
  });
  const readPassword = async (label: string) => {
    process.stdout.write(label);
    hideInput = true;
    try {
      return await prompt.question("");
    } finally {
      hideInput = false;
      process.stdout.write("\n");
    }
  };

  try {
    const username = (await prompt.question("Username [admin]: ")).trim() || "admin";
    const displayName = (await prompt.question("Display name [Admin]: ")).trim() || "Admin";
    const password = await readPassword("Password: ");
    const passwordConfirmation = await readPassword("Confirm password: ");
    return { username, displayName, password, passwordConfirmation };
  } finally {
    prompt.close();
  }
}

export function readProtectedPasswordFile(path: string): string {
  const metadata = statSync(path);
  if (!metadata.isFile()) {
    throw new Error("Password path must be a regular file");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Password file must not be accessible by group or other users");
  }
  return readFileSync(path, "utf8");
}

function optionValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseBootstrapArguments(args: readonly string[]): BootstrapOptions {
  if (args.length === 0) return { interactive: true };

  if (args.some((argument) => argument === "--password" || argument.startsWith("--password="))) {
    throw new Error("Password arguments are forbidden; use --password-file or --password-stdin");
  }

  const username = optionValue(args, "--username")?.trim() ?? "";
  const displayName = optionValue(args, "--display-name")?.trim() ?? "";
  const passwordFile = optionValue(args, "--password-file");
  const passwordStdin = args.includes("--password-stdin");
  const knownOptions = new Set([
    "--username",
    "--display-name",
    "--password-file",
    "--password-stdin",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) continue;
    if (!knownOptions.has(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (
      argument === "--username" ||
      argument === "--display-name" ||
      argument === "--password-file"
    ) {
      index += 1;
    }
  }

  if (!username || !displayName) {
    throw new Error("--username and --display-name are required");
  }
  if (passwordFile && passwordStdin) {
    throw new Error("Choose exactly one of --password-file or --password-stdin");
  }
  if (!passwordFile && !passwordStdin) {
    throw new Error("Choose exactly one of --password-file or --password-stdin");
  }

  return { interactive: false, username, displayName, passwordFile, passwordStdin };
}

export async function bootstrapFirstParticipantAdmin(
  args: readonly string[],
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<number> {
  let options: BootstrapOptions;
  try {
    options = parseBootstrapArguments(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid bootstrap arguments";
    log.warn("Participant bootstrap arguments rejected");
    dependencies.writeError(message);
    return 2;
  }

  try {
    if (options.interactive && !dependencies.isInteractiveTerminal()) {
      dependencies.writeError(
        "Interactive bootstrap requires a terminal. Use --password-file or --password-stdin for automation.",
      );
      return 2;
    }

    const participantCount = dependencies.countParticipants();
    if (participantCount > 0) {
      if (options.interactive) {
        log.warn(
          { participantCount },
          "Participant bootstrap refused because accounts already exist",
        );
        dependencies.writeError(
          "Bootstrap refused: participant accounts already exist. Use the authenticated admin API.",
        );
        return 1;
      }
      const existing = dependencies.findParticipantByUsername(options.username);
      if (existing?.active && existing.role === "admin") {
        log.info(
          { participantId: existing.id, idempotent: true },
          "Participant bootstrap already completed",
        );
        dependencies.writeOutput(
          `Participants are already initialized (admin id: ${existing.id}).`,
        );
        return 0;
      }
      log.warn(
        { participantCount },
        "Participant bootstrap refused because accounts already exist",
      );
      dependencies.writeError(
        "Bootstrap refused: participant accounts already exist. Use the authenticated admin API.",
      );
      return 1;
    }

    if (options.interactive) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      log.debug("[FIX:participant-bootstrap-prompt] Pending terminal output flushed");
    }
    const input = options.interactive
      ? await dependencies.promptInteractive()
      : {
          username: options.username,
          displayName: options.displayName,
          password: options.passwordFile
            ? dependencies.readPasswordFile(options.passwordFile)
            : dependencies.readPasswordStdin(),
          passwordConfirmation: null,
        };
    if (options.interactive) {
      log.info("[FIX:participant-bootstrap-interactive] Interactive credentials collected");
    }
    const username = input.username.trim();
    const displayName = input.displayName.trim();
    if (!username || !displayName) {
      dependencies.writeError("Username and display name are required.");
      return 2;
    }
    if (input.passwordConfirmation !== null && input.password !== input.passwordConfirmation) {
      dependencies.writeError("Passwords do not match.");
      return 2;
    }
    const rawPassword = input.password;
    const password = rawPassword.replace(/\r?\n$/, "");
    if (password.length < 12) {
      dependencies.writeError("Bootstrap password must be at least 12 characters.");
      return 2;
    }

    const created = await dependencies.createParticipant({
      username,
      displayName,
      password,
      role: "admin",
    });
    if (!created.ok) {
      log.error({ code: created.code }, "Participant bootstrap persistence rejected");
      dependencies.writeError(`Bootstrap failed: ${created.code}.`);
      return 1;
    }

    log.info(
      { participantId: created.participant.id },
      "First participant administrator bootstrapped",
    );
    dependencies.writeOutput(
      `Created first participant administrator (id: ${created.participant.id}).`,
    );
    return 0;
  } catch (error) {
    log.error({ error }, "Participant bootstrap failed");
    dependencies.writeError("Bootstrap failed. Check configuration and protected password input.");
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await bootstrapFirstParticipantAdmin(process.argv.slice(2));
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  void main();
}
