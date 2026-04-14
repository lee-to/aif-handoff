import { describe, expect, it } from "vitest";
import { buildLanguageDirective } from "../languagePolicy.js";

describe("buildLanguageDirective", () => {
  it("returns empty string for artifacts=en", () => {
    expect(buildLanguageDirective({ artifacts: "en", technicalTerms: "keep" })).toBe("");
  });

  it("returns empty string for undefined artifacts", () => {
    expect(buildLanguageDirective({ artifacts: undefined, technicalTerms: "keep" })).toBe("");
  });

  it("returns empty string for null artifacts", () => {
    expect(buildLanguageDirective({ artifacts: null, technicalTerms: "keep" })).toBe("");
  });

  it("returns empty string for whitespace-only artifacts", () => {
    expect(buildLanguageDirective({ artifacts: "   ", technicalTerms: "keep" })).toBe("");
  });

  it("includes Russian language and keep-identifiers rule when artifacts=ru & technical_terms=keep", () => {
    const out = buildLanguageDirective({ artifacts: "ru", technicalTerms: "keep" });
    expect(out).toContain("Russian");
    expect(out).toContain("русском");
    expect(out).toContain("identifiers");
    expect(out).toContain("file paths");
    expect(out).toContain("CLI flags");
  });

  it("omits keep-identifiers rule when technical_terms=translate", () => {
    const out = buildLanguageDirective({ artifacts: "fr", technicalTerms: "translate" });
    expect(out).toContain("French");
    expect(out).not.toContain("Keep technical tokens in English");
    expect(out).toContain("translated where a natural equivalent");
  });

  it("resolves uppercase codes case-insensitively", () => {
    const out = buildLanguageDirective({ artifacts: "RU", technicalTerms: "keep" });
    expect(out).toContain("Russian");
  });

  it("handles BCP-47-style region subtags by using the primary code", () => {
    const out = buildLanguageDirective({ artifacts: "pt-BR", technicalTerms: "keep" });
    expect(out).toContain("Portuguese");
  });

  it("falls back to the raw code when the language is not in the lookup table", () => {
    const out = buildLanguageDirective({ artifacts: "eo", technicalTerms: "keep" });
    // Empty directive would only happen for en/unset; unknown codes still produce a directive.
    expect(out).toContain("eo");
    expect(out).toContain("Language policy");
  });
});
