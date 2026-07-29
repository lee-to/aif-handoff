import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createGitTestRoot(
  prefix: string,
  options: { configYaml?: string; readme?: string } = {},
): { rootPath: string; initialSha: string } {
  const rootPath = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.local"], {
    cwd: rootPath,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "T"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: rootPath,
    stdio: "ignore",
  });
  writeFileSync(join(rootPath, "README.md"), options.readme ?? "# test\n");
  if (options.configYaml) {
    mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });
    writeFileSync(join(rootPath, ".ai-factory", "config.yaml"), options.configYaml);
  }
  execFileSync("git", ["add", "-A"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "test: initialize repository", "--no-verify"], {
    cwd: rootPath,
    stdio: "ignore",
  });

  const initialSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootPath,
    encoding: "utf8",
  }).trim();
  return { rootPath, initialSha };
}
