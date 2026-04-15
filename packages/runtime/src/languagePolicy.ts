/**
 * Language directive policy.
 *
 * Given the project's `language.artifacts` + `language.technical_terms` config,
 * produce a compact system-prompt append that instructs the model to write
 * artifacts (task descriptions, plans, review notes, commit messages, chat
 * replies, roadmap items) in the configured language. Returns an empty string
 * when no directive is needed (unset, empty, or `en`) so callers can safely
 * concatenate.
 *
 * Pure function, no I/O, no logging — injection site lives in the runtime
 * registry wrapper so every adapter path gets it automatically.
 */

export interface LanguageDirectiveInput {
  artifacts: string | null | undefined;
  technicalTerms: "keep" | "translate";
}

const LANGUAGE_NAMES: Record<string, string> = {
  ru: "Russian (русском языке)",
  en: "English",
  fr: "French (français)",
  de: "German (Deutsch)",
  es: "Spanish (español)",
  pt: "Portuguese (português)",
  it: "Italian (italiano)",
  pl: "Polish (polski)",
  uk: "Ukrainian (українською)",
  tr: "Turkish (Türkçe)",
  zh: "Chinese (中文)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
};

function primarySubtag(code: string): string {
  return code.toLowerCase().split(/[-_]/, 1)[0] ?? "";
}

function resolveLanguageName(code: string): string {
  return LANGUAGE_NAMES[primarySubtag(code)] ?? code;
}

export function buildLanguageDirective(input: LanguageDirectiveInput): string {
  const raw = (input.artifacts ?? "").trim().toLowerCase();
  // No-op not only for exact `en` but for any BCP-47 tag whose primary
  // subtag is English (`en-US`, `en_GB`, `en-x-private`, …). Without this,
  // regional English settings would still inject a directive asking the
  // model to "write in English", which is noise at best and misleading
  // (since the lookup table would stringify `en-US` as the raw tag).
  if (!raw || primarySubtag(raw) === "en") return "";

  const languageName = resolveLanguageName(raw);
  const lines = [
    "Language policy for all produced artifacts:",
    `- Write all generated artifacts — task descriptions, plans, review notes, commit messages, chat replies, and roadmap items — in ${languageName}.`,
    "- Apply this to free-form prose only; it does not change the meaning of the task.",
  ];

  if (input.technicalTerms === "keep") {
    lines.push(
      "- Keep technical tokens in English: identifiers, API/function/class names, file paths, CLI flags, environment variables, code snippets, log strings, and error messages emitted by the code.",
    );
  } else {
    lines.push(
      "- Technical tokens may be translated where a natural equivalent exists; otherwise keep them verbatim.",
    );
  }

  return lines.join("\n");
}
