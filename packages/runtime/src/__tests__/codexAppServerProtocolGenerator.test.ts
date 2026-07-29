import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const generatorScript = fileURLToPath(
  new URL("../../scripts/generate-codex-app-server-protocol.mjs", import.meta.url),
);
const repositoryNodeModules = fileURLToPath(new URL("../../../../node_modules/", import.meta.url));
const installedCodexSdkVersion = (
  JSON.parse(
    readFileSync(path.join(repositoryNodeModules, "@openai", "codex-sdk", "package.json"), "utf8"),
  ) as { version: string }
).version;
const aggregateSchemaFiles = [
  "codex_app_server_protocol.schemas.json",
  "codex_app_server_protocol.v2.schemas.json",
];

interface GeneratorFixture {
  executablePath: string;
  generatedDir: string;
  root: string;
  scriptPath: string;
}

describe("codex app-server protocol generator", () => {
  it("uses CODEX_CLI_PATH when launching Codex", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "aif-codex-cli-path-"));
    const missingExecutable = path.join(tempDir, "missing codex executable.cmd");

    try {
      const result = spawnSync(process.execPath, [generatorScript, "--check"], {
        env: {
          ...process.env,
          CODEX_CLI_PATH: missingExecutable,
        },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Codex CLI executable");
      expect(result.stderr).toContain(missingExecutable);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("commits TypeScript and aggregate schemas without granular schemas", () => {
    const fixture = createGeneratorFixture();

    try {
      const staleSchemaPath = path.join(fixture.generatedDir, "schema", "v2", "Stale.json");
      mkdirSync(path.dirname(staleSchemaPath), { recursive: true });
      writeFileSync(staleSchemaPath, '{"title":"stale"}\n', "utf8");

      const result = runGenerator(fixture);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("committed protocol artifacts generated");
      expect(readFileSync(path.join(fixture.generatedDir, "README.md"), "utf8")).toBe(
        "fixture readme\n",
      );
      expect(existsSync(path.join(fixture.generatedDir, "Protocol.ts"))).toBe(true);
      expect(existsSync(path.join(fixture.generatedDir, "v2", "ThreadStartParams.ts"))).toBe(true);
      expect(readdirSync(path.join(fixture.generatedDir, "schema")).sort()).toEqual(
        [...aggregateSchemaFiles].sort(),
      );
      expect(existsSync(path.join(fixture.generatedDir, "schema", "Protocol.json"))).toBe(false);
      expect(existsSync(path.join(fixture.generatedDir, "schema", "v2"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("checks the curated baseline and rejects committed granular schemas", () => {
    const fixture = createGeneratorFixture();

    try {
      expect(runGenerator(fixture).status).toBe(0);

      const cleanCheck = runGenerator(fixture, ["--check"]);
      expect(cleanCheck.status).toBe(0);
      expect(cleanCheck.stdout).toContain("artifacts are in sync");

      writeFileSync(
        path.join(fixture.generatedDir, "schema", "Protocol.json"),
        '{"title":"unexpected"}\n',
        "utf8",
      );
      const staleCheck = runGenerator(fixture, ["--check"]);

      expect(staleCheck.status).not.toBe(0);
      expect(staleCheck.stderr).toContain("stale committed file schema/Protocol.json");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("detects TypeScript and aggregate-schema drift", () => {
    const fixture = createGeneratorFixture();

    try {
      expect(runGenerator(fixture).status).toBe(0);

      writeFileSync(
        path.join(fixture.generatedDir, "Protocol.ts"),
        "export type Protocol = number;\n",
        "utf8",
      );
      const typeDriftCheck = runGenerator(fixture, ["--check"]);
      expect(typeDriftCheck.status).not.toBe(0);
      expect(typeDriftCheck.stderr).toContain("changed file Protocol.ts");

      expect(runGenerator(fixture).status).toBe(0);
      writeFileSync(
        path.join(fixture.generatedDir, "schema", aggregateSchemaFiles[0]),
        '{"title":"changed"}\n',
        "utf8",
      );
      const schemaDriftCheck = runGenerator(fixture, ["--check"]);
      expect(schemaDriftCheck.status).not.toBe(0);
      expect(schemaDriftCheck.stderr).toContain(`changed file schema/${aggregateSchemaFiles[0]}`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a Codex CLI version that does not match the installed SDK", () => {
    const fixture = createGeneratorFixture("9.9.9");

    try {
      const result = runGenerator(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `requires matching SDK and CLI versions, but found SDK ${installedCodexSdkVersion} and CLI 9.9.9`,
      );
      expect(existsSync(path.join(fixture.generatedDir, "Protocol.ts"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function createGeneratorFixture(cliVersion = installedCodexSdkVersion): GeneratorFixture {
  const root = mkdtempSync(path.join(tmpdir(), "aif-codex-protocol-generator-test-"));
  const scriptsDir = path.join(root, "scripts");
  const generatedDir = path.join(root, "src", "adapters", "codex", "appServer", "generated");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(path.join(generatedDir, "README.md"), "fixture readme\n", "utf8");

  const scriptPath = path.join(scriptsDir, path.basename(generatorScript));
  copyFileSync(generatorScript, scriptPath);
  symlinkSync(
    repositoryNodeModules,
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const fakeCliScript = path.join(root, "fake-codex.mjs");
  writeFileSync(fakeCliScript, buildFakeCliSource(cliVersion), "utf8");
  const executablePath = createExecutableWrapper(root, fakeCliScript);

  return {
    executablePath,
    generatedDir,
    root,
    scriptPath,
  };
}

function createExecutableWrapper(root: string, fakeCliScript: string): string {
  if (process.platform === "win32") {
    const executablePath = path.join(root, "fake-codex.cmd");
    writeFileSync(
      executablePath,
      `@echo off\r\n"${process.execPath}" "${fakeCliScript}" %*\r\n`,
      "utf8",
    );
    return executablePath;
  }

  const executablePath = path.join(root, "fake-codex");
  writeFileSync(
    executablePath,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCliScript}" "$@"\n`,
    "utf8",
  );
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function runGenerator(fixture: GeneratorFixture, args: string[] = []) {
  return spawnSync(process.execPath, [fixture.scriptPath, ...args], {
    cwd: fixture.root,
    env: {
      ...process.env,
      CODEX_CLI_PATH: fixture.executablePath,
    },
    encoding: "utf8",
  });
}

function buildFakeCliSource(cliVersion: string): string {
  return `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli ${cliVersion}");
  process.exit(0);
}

const outputIndex = args.indexOf("--out");
if (args[0] !== "app-server" || outputIndex < 0 || !args[outputIndex + 1]) {
  console.error("unexpected fake Codex invocation", args);
  process.exit(2);
}

const outputDir = args[outputIndex + 1];
mkdirSync(outputDir, { recursive: true });

if (args[1] === "generate-ts") {
  writeText("Protocol.ts", "export interface Protocol { id: string }\\n");
  writeText("v2/ThreadStartParams.ts", "export interface ThreadStartParams { cwd: string }\\n");
  process.exit(0);
}

if (args[1] === "generate-json-schema") {
  writeJson("codex_app_server_protocol.schemas.json", {
    title: "CodexAppServerProtocol",
    definitions: { Protocol: { type: "object" } },
  });
  writeJson("codex_app_server_protocol.v2.schemas.json", {
    title: "CodexAppServerProtocolV2",
    definitions: { ThreadStartParams: { type: "object" } },
  });
  writeJson("Protocol.json", { title: "Protocol", type: "object" });
  writeJson("v2/ThreadStartParams.json", { title: "ThreadStartParams", type: "object" });
  process.exit(0);
}

console.error("unexpected fake Codex subcommand", args);
process.exit(2);

function writeText(relativePath, contents) {
  const destination = path.join(outputDir, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents, "utf8");
}

function writeJson(relativePath, contents) {
  writeText(relativePath, JSON.stringify(contents, null, 2) + "\\n");
}
`;
}
