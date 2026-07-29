import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const dockerfile = readFileSync(resolve(repositoryRoot, ".docker/Dockerfile"), "utf8");
const developmentCompose = readFileSync(resolve(repositoryRoot, "docker-compose.yml"), "utf8");
const environmentExample = readFileSync(resolve(repositoryRoot, ".env.example"), "utf8");
const configurationReference = readFileSync(
  resolve(repositoryRoot, "docs/configuration.md"),
  "utf8",
);
const readme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
const gettingStarted = readFileSync(resolve(repositoryRoot, "docs/getting-started.md"), "utf8");
const providers = readFileSync(resolve(repositoryRoot, "docs/providers.md"), "utf8");
const runtimePackage = JSON.parse(
  readFileSync(resolve(repositoryRoot, "packages/runtime/package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const packageLock = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8"),
) as { packages: Record<string, { dependencies?: Record<string, string> }> };
const bunLock = readFileSync(resolve(repositoryRoot, "bun.lock"), "utf8");
const reviewedCodexVersion = "0.145.0";

describe("Docker Codex version resolution", () => {
  it("defaults to the reviewed SDK version while retaining the build selector", () => {
    expect(runtimePackage.dependencies["@openai/codex-sdk"]).toBe(reviewedCodexVersion);
    expect(packageLock.packages["packages/runtime"].dependencies?.["@openai/codex-sdk"]).toBe(
      reviewedCodexVersion,
    );
    expect(bunLock).toContain(`"@openai/codex-sdk": "${reviewedCodexVersion}"`);
    expect(dockerfile).toContain(`ARG CODEX_VERSION=${reviewedCodexVersion}`);
    expect(dockerfile).toContain('"@openai/codex-sdk@${CODEX_VERSION}"');
    expect(dockerfile).toContain("--prefix /opt/codex");
    expect(dockerfile).toContain("--package-lock=false");
    expect(dockerfile).toContain(
      "COPY --from=codex /opt/codex/node_modules/@openai ./node_modules/@openai",
    );
    expect(dockerfile).toContain("npm ci --ignore-scripts");
    const protocolGeneration = dockerfile.indexOf(
      "npm run codex:app-server:protocol:generate --workspace=@aif/runtime",
    );
    const applicationBuild = dockerfile.indexOf("npx turbo build");
    expect(protocolGeneration).toBeGreaterThan(-1);
    expect(protocolGeneration).toBeLessThan(applicationBuild);
  });

  it("uses the CLI shipped with the selected SDK", () => {
    expect(dockerfile).toContain("CODEX_CLI_PATH=/app/node_modules/.bin/codex");
    expect(dockerfile).toContain("PATH=/app/node_modules/.bin:${PATH}");
    expect(dockerfile).not.toMatch(/npm i -g [^\n]*@openai\/codex/);
  });

  // Only the development compose builds images. compose.production.yml is a prod
  // overlay that resets `build` to null and pulls prebuilt images from GHCR, so
  // build args (including CODEX_VERSION) do not apply there.
  it.each([["development", developmentCompose]])(
    "passes CODEX_VERSION through every %s image build",
    (_name, compose) => {
      expect(
        compose.match(
          new RegExp(`CODEX_VERSION: \\$\\{CODEX_VERSION:-${reviewedCodexVersion}\\}`, "g"),
        ),
      ).toHaveLength(4);
    },
  );

  it("documents the reviewed default and intentional moving-selector rollout", () => {
    expect(environmentExample).toContain(`CODEX_VERSION=${reviewedCodexVersion}`);
    expect(readme).toContain(`defaults to the reviewed \`${reviewedCodexVersion}\` baseline`);
    expect(gettingStarted.split("\n").find((line) => line.includes("| `CODEX_VERSION`"))).toContain(
      `\`${reviewedCodexVersion}\``,
    );
    expect(providers).toContain(`(\`${reviewedCodexVersion}\` by default`);
    const configurationRow = configurationReference
      .split("\n")
      .find((line) => line.includes("| `CODEX_VERSION`"));

    expect(configurationRow).toBeDefined();
    expect(configurationRow).toContain("| string");
    expect(configurationRow).toContain(`| \`${reviewedCodexVersion}\``);
    expect(configurationRow).toContain("build-time");
    expect(configurationRow).toContain("dist-tags");
    expect(configurationRow).toContain("exact versions");
    expect(configurationRow).toContain("semver ranges");
    expect(configurationRow).toContain("--no-cache");
  });
});
