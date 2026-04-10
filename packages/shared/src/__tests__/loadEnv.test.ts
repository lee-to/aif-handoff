import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const dotenvParseMock = vi.fn();
const findMonorepoRootFromUrlMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

vi.mock("dotenv", () => ({
  parse: dotenvParseMock,
}));

vi.mock("../monorepoRoot.js", () => ({
  findMonorepoRootFromUrl: findMonorepoRootFromUrlMock,
}));

describe("loadEnv", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
    dotenvParseMock.mockReset();
    findMonorepoRootFromUrlMock.mockReset();
    findMonorepoRootFromUrlMock.mockReturnValue("/repo-root");
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
    delete process.env.DATABASE_URL;
    delete process.env.API_BASE_URL;
  });

  it("skips dotenv loading in test environment (VITEST is set)", async () => {
    existsSyncMock.mockReturnValue(true);
    await import("../loadEnv.js");

    expect(dotenvParseMock).not.toHaveBeenCalled();
  });

  it("skips dotenv loading when root env files are missing", async () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    existsSyncMock.mockReturnValue(false);
    await import("../loadEnv.js");

    expect(dotenvParseMock).not.toHaveBeenCalled();
  });

  it("preserves explicit process env values over .env files", async () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "C:/explicit/db.sqlite";

    existsSyncMock.mockImplementation((path: string) => String(path).endsWith(".env"));
    readFileSyncMock.mockReturnValue("DATABASE_URL=/repo-root/data/aif.sqlite\nLOG_LEVEL=debug\n");
    dotenvParseMock.mockReturnValue({
      DATABASE_URL: "/repo-root/data/aif.sqlite",
      LOG_LEVEL: "debug",
    });

    await import("../loadEnv.js");

    expect(process.env.DATABASE_URL).toBe("C:/explicit/db.sqlite");
    expect(process.env.LOG_LEVEL).toBe("debug");
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it(".env.local overrides .env values, but not explicit process env", async () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    process.env.API_BASE_URL = "http://explicit-host:3009";

    existsSyncMock.mockReturnValue(true);
    readFileSyncMock
      .mockReturnValueOnce("LOG_LEVEL=info\nAPI_BASE_URL=http://from-env:3009\n")
      .mockReturnValueOnce("LOG_LEVEL=trace\nAPI_BASE_URL=http://from-env-local:3009\n");
    dotenvParseMock
      .mockReturnValueOnce({
        LOG_LEVEL: "info",
        API_BASE_URL: "http://from-env:3009",
      })
      .mockReturnValueOnce({
        LOG_LEVEL: "trace",
        API_BASE_URL: "http://from-env-local:3009",
      });

    await import("../loadEnv.js");

    expect(process.env.LOG_LEVEL).toBe("trace");
    expect(process.env.API_BASE_URL).toBe("http://explicit-host:3009");
  });
});
