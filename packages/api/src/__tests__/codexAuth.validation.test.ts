import { describe, expect, it } from "vitest";
import { codexCallbackSchema } from "../schemas.js";

function check(url: string): { ok: boolean; reason?: string } {
  const result = codexCallbackSchema.safeParse({ url });
  if (result.success) return { ok: true };
  return { ok: false, reason: result.error.issues[0]?.message };
}

describe("codexCallbackSchema", () => {
  it("accepts a valid loopback callback URL", () => {
    expect(check("http://127.0.0.1:1455/?code=abc&state=xyz").ok).toBe(true);
    expect(check("http://localhost:1455/?code=abc&state=xyz").ok).toBe(true);
  });

  it("rejects https scheme", () => {
    expect(check("https://127.0.0.1:1455/?code=c&state=s").reason).toBe("scheme_not_allowed");
  });

  it("rejects an external host on the allowed port", () => {
    expect(check("http://evil.com:1455/?code=c&state=s").reason).toBe("host_not_allowed");
  });

  it("rejects the wrong port", () => {
    expect(check("http://127.0.0.1:80/?code=c&state=s").reason).toBe("port_not_allowed");
  });

  it("rejects missing code", () => {
    expect(check("http://localhost:1455/?state=s").reason).toBe("missing_code");
  });

  it("rejects missing state", () => {
    expect(check("http://localhost:1455/?code=c").reason).toBe("missing_state");
  });

  it("rejects unparseable URL", () => {
    expect(check("::::").reason).toBe("invalid_url");
  });
});
