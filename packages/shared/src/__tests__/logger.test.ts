import { describe, expect, it } from "vitest";
import { resolveLogDestination, resolveLogDestinationConfig } from "../logger.js";

describe("logger", () => {
  it("defaults to stdout when LOG_DESTINATION is not set", () => {
    expect(resolveLogDestination({})).toBe(1);
  });

  it("routes logs to stderr when LOG_DESTINATION=stderr", () => {
    expect(resolveLogDestination({ LOG_DESTINATION: "stderr" })).toBe(2);
  });

  it("accepts numeric stderr destination values", () => {
    expect(resolveLogDestination({ LOG_DESTINATION: "2" })).toBe(2);
  });

  it("uses sync destination outside production", () => {
    expect(resolveLogDestinationConfig({ NODE_ENV: "development" })).toEqual({
      dest: 1,
      sync: true,
    });
  });

  it("uses async destination in production", () => {
    expect(
      resolveLogDestinationConfig({ NODE_ENV: "production", LOG_DESTINATION: "stderr" }),
    ).toEqual({
      dest: 2,
      sync: false,
    });
  });
});
