#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, "..");
const generatedDir = path.join(runtimeRoot, "src/adapters/codex/appServer/generated");
const checkMode = process.argv.includes("--check");
const schemaBaselineFiles = new Set([
  "schema/codex_app_server_protocol.schemas.json",
  "schema/codex_app_server_protocol.v2.schemas.json",
]);
const debugEnabled = ["debug", "trace"].includes(
  (process.env.LOG_LEVEL ?? "").trim().toLowerCase(),
);

try {
  await main();
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "aif-codex-app-server-protocol-"));
  const tempGeneratedDir = path.join(tempRoot, "generated");
  const tempSchemaDir = path.join(tempGeneratedDir, "schema");

  try {
    const executablePath = resolveCodexExecutable();
    const cliVersion = readCodexCliVersion(executablePath);
    const sdkVersion = resolveInstalledCodexSdkVersion();
    assertMatchingCodexVersions({ cliVersion, sdkVersion });
    debugLog("validated Codex generator version", {
      cliVersion,
      executablePath,
      sdkVersion,
    });

    await generateInto({
      executablePath,
      schemaOut: tempSchemaDir,
      typesOut: tempGeneratedDir,
    });

    if (checkMode) {
      const diff = diffDirectories(generatedDir, tempGeneratedDir);
      if (diff.length > 0) {
        throw new Error(
          `Generated Codex app-server protocol artifacts are out of sync:\n${diff
            .slice(0, 20)
            .map((entry) => `- ${entry}`)
            .join("\n")}\nRun "npm run -w @aif/runtime codex:app-server:protocol:generate".`,
        );
      }
      console.log(`Codex app-server protocol artifacts are in sync with CLI ${cliVersion}.`);
      return;
    }

    syncCommittedArtifacts(tempGeneratedDir, generatedDir);
    console.log(`Codex app-server committed protocol artifacts generated from CLI ${cliVersion}.`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function generateInto({ executablePath, typesOut, schemaOut }) {
  debugLog("generating Codex TypeScript artifacts", { typesOut });
  runCodex(executablePath, ["app-server", "generate-ts", "--out", typesOut]);
  debugLog("generating Codex JSON Schema artifacts", { schemaOut });
  runCodex(executablePath, ["app-server", "generate-json-schema", "--out", schemaOut]);
  await formatGeneratedArtifacts(typesOut);
}

function syncCommittedArtifacts(sourceRoot, destinationRoot) {
  const sourceFiles = listCommittedArtifactFiles(sourceRoot);
  assertRequiredGeneratedArtifacts(sourceFiles);
  const sourceFileSet = new Set(sourceFiles);
  const destinationFiles = listFiles(destinationRoot);
  let copiedArtifactCount = 0;
  let removedArtifactCount = 0;
  let unchangedArtifactCount = 0;

  for (const file of destinationFiles) {
    if (sourceFileSet.has(file)) {
      continue;
    }
    rmSync(path.join(destinationRoot, file), { force: true });
    removedArtifactCount += 1;
  }

  for (const file of sourceFiles) {
    const sourcePath = path.join(sourceRoot, file);
    const destinationPath = path.join(destinationRoot, file);
    if (
      existsSync(destinationPath) &&
      normalizeFile(file, readFileSync(destinationPath, "utf8")) ===
        normalizeFile(file, readFileSync(sourcePath, "utf8"))
    ) {
      unchangedArtifactCount += 1;
      continue;
    }
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
    copiedArtifactCount += 1;
  }
  pruneEmptyDirectories(destinationRoot);

  debugLog("synchronized committed Codex protocol artifacts", {
    artifactCount: sourceFiles.length,
    copiedArtifactCount,
    destinationRoot,
    removedArtifactCount,
    unchangedArtifactCount,
  });
}

function pruneEmptyDirectories(root, removeRoot = false) {
  for (const entry of readdirSync(root)) {
    const entryPath = path.join(root, entry);
    if (statSync(entryPath).isDirectory()) {
      pruneEmptyDirectories(entryPath, true);
    }
  }
  if (removeRoot && readdirSync(root).length === 0) {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCodex(executablePath, args) {
  let commandSpec;
  try {
    commandSpec = buildCodexCommand(executablePath, args);
  } catch (error) {
    throw new Error(
      `Refusing to execute Codex CLI executable "${executablePath}": ${getErrorMessage(error)}`,
    );
  }
  const result = spawnSync(commandSpec.command, commandSpec.commandArgs, {
    cwd: runtimeRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(
      `Failed to execute Codex CLI executable "${executablePath}". Install @openai/codex, ensure "codex" is in PATH, or set CODEX_CLI_PATH: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Codex CLI executable "${executablePath}" exited with status ${result.status ?? "null"} while running: ${formatCodexInvocation(
        executablePath,
        args,
      )}`,
    );
  }
}

function resolveCodexExecutable() {
  const configured = process.env.CODEX_CLI_PATH;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  return "codex";
}

function readCodexCliVersion(executablePath) {
  let commandSpec;
  try {
    commandSpec = buildCodexCommand(executablePath, ["--version"]);
  } catch (error) {
    throw new Error(
      `Refusing to execute Codex CLI executable "${executablePath}": ${getErrorMessage(error)}`,
    );
  }

  const result = spawnSync(commandSpec.command, commandSpec.commandArgs, {
    cwd: runtimeRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(
      `Failed to execute Codex CLI executable "${executablePath}". Install @openai/codex, ensure "codex" is in PATH, or set CODEX_CLI_PATH: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Codex CLI executable "${executablePath}" exited with status ${result.status ?? "null"} while checking its version.`,
    );
  }

  const firstOutputLine = String(result.stdout ?? "")
    .trim()
    .split(/\r?\n/, 1)[0];
  const cliVersion = firstOutputLine?.trim().split(/\s+/).at(-1);
  if (!cliVersion || !isVersionToken(cliVersion)) {
    throw new Error(
      `Could not parse Codex CLI version from executable "${executablePath}". Received: ${JSON.stringify(firstOutputLine ?? "")}`,
    );
  }
  return cliVersion;
}

function resolveInstalledCodexSdkVersion() {
  const sdkEntryPath = fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
  let currentDirectory = path.dirname(sdkEntryPath);

  while (true) {
    const packageJsonPath = path.join(currentDirectory, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (packageJson?.name === "@openai/codex-sdk") {
        if (typeof packageJson.version !== "string" || !isVersionToken(packageJson.version)) {
          throw new Error(
            `Installed @openai/codex-sdk has an invalid package version in "${packageJsonPath}".`,
          );
        }
        return packageJson.version;
      }
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  throw new Error(
    `Could not locate package.json for installed @openai/codex-sdk from "${sdkEntryPath}".`,
  );
}

function assertMatchingCodexVersions({ cliVersion, sdkVersion }) {
  if (cliVersion !== sdkVersion) {
    throw new Error(
      `Codex protocol generation requires matching SDK and CLI versions, but found SDK ${sdkVersion} and CLI ${cliVersion}. Use the CLI installed with @openai/codex-sdk or update CODEX_CLI_PATH.`,
    );
  }
}

function isVersionToken(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function buildCodexCommand(executablePath, args) {
  if (process.platform !== "win32") {
    return {
      command: executablePath,
      commandArgs: args,
    };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    commandArgs: [
      "/d",
      "/s",
      "/c",
      [executablePath, ...args].map(quoteSafeWindowsShellArg).join(" "),
    ],
  };
}

async function formatGeneratedArtifacts(root) {
  const prettier = await import("prettier");
  const config = (await prettier.resolveConfig(runtimeRoot)) ?? {};
  for (const file of listCommittedArtifactFiles(root)) {
    const filePath = path.join(root, file);
    const source = readFileSync(filePath, "utf8");
    const formatted = await prettier.format(source, {
      ...config,
      filepath: filePath,
    });
    if (formatted !== source) {
      writeFileSync(filePath, formatted, "utf8");
    }
  }
}

function diffDirectories(leftRoot, rightRoot) {
  const leftFiles = listFiles(leftRoot);
  const rightFiles = listCommittedArtifactFiles(rightRoot);
  assertRequiredGeneratedArtifacts(rightFiles);
  const allFiles = [...new Set([...leftFiles, ...rightFiles])].sort();
  const leftFileSet = new Set(leftFiles);
  const rightFileSet = new Set(rightFiles);
  const diff = [];
  for (const file of allFiles) {
    const leftPath = path.join(leftRoot, file);
    const rightPath = path.join(rightRoot, file);
    if (!leftFileSet.has(file)) {
      diff.push(`missing committed file ${file}`);
      continue;
    }
    if (!rightFileSet.has(file)) {
      diff.push(`stale committed file ${file}`);
      continue;
    }
    const left = readFileSync(leftPath, "utf8");
    const right = readFileSync(rightPath, "utf8");
    if (normalizeFile(file, left) !== normalizeFile(file, right)) {
      diff.push(`changed file ${file}`);
    }
  }
  return diff;
}

function listCommittedArtifactFiles(root) {
  return listFiles(root).filter(isCommittedProtocolArtifact);
}

function isCommittedProtocolArtifact(file) {
  return file.endsWith(".ts") || schemaBaselineFiles.has(file);
}

function assertRequiredGeneratedArtifacts(files) {
  if (!files.some((file) => file.endsWith(".ts"))) {
    throw new Error("Codex CLI did not generate any TypeScript protocol artifacts.");
  }
  for (const schemaFile of schemaBaselineFiles) {
    if (!files.includes(schemaFile)) {
      throw new Error(`Codex CLI did not generate required aggregate schema "${schemaFile}".`);
    }
  }
}

function listFiles(root) {
  const files = [];
  walk(root, "");
  return files.sort();

  function walk(currentRoot, relativeRoot) {
    for (const entry of readdirSync(currentRoot)) {
      if (entry === "README.md") {
        continue;
      }
      const absolutePath = path.join(currentRoot, entry);
      const relativePath = path.join(relativeRoot, entry);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (stats.isFile()) {
        files.push(relativePath.split(path.sep).join("/"));
      }
    }
  }
}

function normalizeText(value) {
  return value.replace(/\r\n/g, "\n");
}

function normalizeFile(file, value) {
  if (file.endsWith(".json")) {
    return `${stableStringify(JSON.parse(value))}\n`;
  }
  return normalizeText(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatCodexInvocation(executablePath, args) {
  return [executablePath, ...args].join(" ");
}

function quoteSafeWindowsShellArg(value) {
  assertSafeWindowsShellArg(value);
  return /[\s()]/.test(value) ? `"${value}"` : value;
}

function assertSafeWindowsShellArg(value) {
  if (/[\r\n&|<>^%"]/.test(value)) {
    throw new Error(
      "Unsafe Codex CLI executable or argument contains Windows shell metacharacters",
    );
  }
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function debugLog(message, context) {
  if (!debugEnabled) {
    return;
  }
  console.log(`[codex-app-server-protocol] ${message} ${JSON.stringify(context)}`);
}
