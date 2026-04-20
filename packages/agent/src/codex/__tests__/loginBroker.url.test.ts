import { describe, expect, it } from "vitest";
import {
  extractAuthUrlFromStdout,
  extractStateFromAuthUrl,
  redactCallbackUrl,
  validateCallbackUrl,
} from "../loginBroker.js";

const validatorOpts = { loopbackHost: "127.0.0.1", loopbackPort: 1455, expectedState: "S1" };

describe("extractAuthUrlFromStdout", () => {
  it("picks the first https auth URL in a mixed chunk", () => {
    const chunk =
      "Starting login.\nVisit https://chatgpt.com/auth/authorize?client_id=abc&state=S1 to continue.\n";
    expect(extractAuthUrlFromStdout(chunk)).toContain("chatgpt.com/auth/authorize");
  });

  it("returns null when no URL is present", () => {
    expect(extractAuthUrlFromStdout("no urls here")).toBeNull();
  });
});

describe("extractStateFromAuthUrl", () => {
  it("extracts the state query param", () => {
    expect(
      extractStateFromAuthUrl("https://chatgpt.com/auth/authorize?client_id=x&state=abc123"),
    ).toBe("abc123");
  });

  it("returns null when URL has no state", () => {
    expect(extractStateFromAuthUrl("https://chatgpt.com/authorize")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(extractStateFromAuthUrl("not-a-url")).toBeNull();
  });
});

describe("validateCallbackUrl", () => {
  it("accepts a well-formed localhost callback", () => {
    const result = validateCallbackUrl("http://localhost:1455/?code=ABC&state=S1", validatorOpts);
    expect(result.ok).toBe(true);
  });

  it("rejects https scheme", () => {
    expect(
      validateCallbackUrl("https://127.0.0.1:1455/?code=c&state=S1", validatorOpts).reason,
    ).toBe("scheme_not_allowed");
  });

  it("rejects non-loopback host", () => {
    expect(validateCallbackUrl("http://evil.com:1455/?code=c&state=S1", validatorOpts).reason).toBe(
      "host_not_allowed",
    );
  });

  it("rejects wrong port", () => {
    expect(validateCallbackUrl("http://127.0.0.1:80/?code=c&state=S1", validatorOpts).reason).toBe(
      "port_not_allowed",
    );
  });

  it("rejects missing code", () => {
    expect(validateCallbackUrl("http://localhost:1455/?state=S1", validatorOpts).reason).toBe(
      "missing_code",
    );
  });

  it("rejects state mismatch", () => {
    expect(
      validateCallbackUrl("http://localhost:1455/?code=c&state=OTHER", validatorOpts).reason,
    ).toBe("state_mismatch");
  });

  it("accepts when expectedState is null (no match enforced)", () => {
    const result = validateCallbackUrl("http://localhost:1455/?code=c&state=any", {
      ...validatorOpts,
      expectedState: null,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unparseable URL", () => {
    expect(validateCallbackUrl("::::not a url::::", validatorOpts).reason).toBe("invalid_url");
  });
});

describe("redactCallbackUrl", () => {
  it("masks code and state params", () => {
    const redacted = redactCallbackUrl("http://localhost:1455/?code=SECRET&state=S1&other=keep");
    expect(redacted).not.toContain("SECRET");
    expect(redacted).not.toContain("S1");
    expect(redacted).toContain("other=keep");
    expect(redacted).toContain("***redacted***");
  });

  it("returns placeholder for unparseable input", () => {
    expect(redactCallbackUrl("::::")).toBe("<unparseable-url>");
  });
});
