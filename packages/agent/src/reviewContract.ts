import { createHash } from "node:crypto";
import type {
  AutoReviewFinding,
  AutoReviewFindingSource,
  AutoReviewState,
  AutoReviewStrategy,
} from "@aif/shared";

export type AutoReviewPreviousFindingStatus = "resolved" | "still_blocking";

export interface AutoReviewPreviousFinding extends AutoReviewFinding {
  status: AutoReviewPreviousFindingStatus;
  note: string;
}

export interface AutoReviewAdvisory {
  source: AutoReviewFindingSource;
  text: string;
}

export interface ParsedStructuredSidecarOutput {
  blockingFindings: AutoReviewFinding[];
  advisories: AutoReviewAdvisory[];
  previousFindings: AutoReviewPreviousFinding[];
}

export interface ParsedStructuredReviewComments {
  strategy: AutoReviewStrategy;
  iteration: number;
  blockingFindings: AutoReviewFinding[];
  advisories: AutoReviewAdvisory[];
  previousFindings: AutoReviewPreviousFinding[];
}

function collectSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }
    if (current) {
      sections.get(current)?.push(line);
    }
  }

  return sections;
}

function normalizeListSection(lines: string[] | undefined): string[] | null {
  if (!lines) return null;

  const normalized = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (normalized.length === 0) return [];
  if (normalized.every((line) => line.startsWith("- "))) {
    const items = normalized.map((line) => line.slice(2).trim());
    if (items.length === 1 && items[0]?.toLowerCase() === "none") {
      return [];
    }
    if (items.some((item) => item.length === 0 || item.toLowerCase() === "none")) {
      return null;
    }
    return items;
  }

  return null;
}

export function normalizeFindingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function createAutoReviewFindingId(source: AutoReviewFindingSource, text: string): string {
  const normalized = `${source}:${normalizeFindingText(text).toLowerCase()}`;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

export function formatPreviousFindingsForPrompt(
  findings: AutoReviewFinding[],
  source?: AutoReviewFindingSource,
): string {
  const filtered = source ? findings.filter((finding) => finding.source === source) : findings;
  if (filtered.length === 0) {
    return "- none";
  }

  return filtered.map((finding) => `- [${finding.id}] ${finding.text}`).join("\n");
}

export function parseStructuredSidecarOutput(
  resultText: string,
  source: AutoReviewFindingSource,
  previousFindingsInput: AutoReviewFinding[] = [],
): ParsedStructuredSidecarOutput | null {
  const sections = collectSections(resultText);
  const blockingItems = normalizeListSection(sections.get("Blocking Findings"));
  const advisoryItems = normalizeListSection(sections.get("Advisories"));
  const previousItems = normalizeListSection(sections.get("Previous Findings") ?? []);

  if (!blockingItems || !advisoryItems || previousItems === null) {
    return null;
  }

  const previousFindings: AutoReviewPreviousFinding[] = [];
  const previousFindingMap = new Map(previousFindingsInput.map((finding) => [finding.id, finding]));
  for (const item of previousItems) {
    const match = item.match(/^\[([^\]]+)\]\s+(resolved|still_blocking)\s+\|\s+(.+)$/);
    if (!match) {
      return null;
    }
    const matchedFinding = previousFindingMap.get(match[1]);
    if (!matchedFinding && previousFindingsInput.length > 0) {
      return null;
    }
    previousFindings.push({
      id: match[1],
      source: matchedFinding?.source ?? source,
      status: match[2] as AutoReviewPreviousFindingStatus,
      note: normalizeFindingText(match[3]),
      text: normalizeFindingText(match[3]),
    });
  }

  if (
    previousFindingsInput.length > 0 &&
    previousFindings.length !== previousFindingsInput.length
  ) {
    return null;
  }

  return {
    blockingFindings: blockingItems.map((item) => ({
      id: createAutoReviewFindingId(source, item),
      text: normalizeFindingText(item),
      source,
    })),
    advisories: advisoryItems.map((item) => ({
      source,
      text: normalizeFindingText(item),
    })),
    previousFindings,
  };
}

function formatCanonicalPreviousFindingLine(finding: AutoReviewPreviousFinding): string {
  return `- [${finding.id}] ${finding.source} | ${finding.status} | ${finding.note}`;
}

function formatCanonicalBlockingFindingLine(finding: AutoReviewFinding): string {
  return `- [${finding.id}] ${finding.source} | ${finding.text}`;
}

function formatCanonicalAdvisoryLine(advisory: AutoReviewAdvisory): string {
  return `- ${advisory.source} | ${advisory.text}`;
}

export function buildStructuredReviewComments(input: {
  strategy: AutoReviewStrategy;
  iteration: number;
  codeReview: ParsedStructuredSidecarOutput;
  securityAudit: ParsedStructuredSidecarOutput;
  rawCodeReview: string;
  rawSecurityAudit: string;
}): string {
  const previousFindings = [
    ...input.codeReview.previousFindings,
    ...input.securityAudit.previousFindings,
  ];
  const advisories = [...input.codeReview.advisories, ...input.securityAudit.advisories];
  const blockingMap = new Map<string, AutoReviewFinding>();

  for (const finding of previousFindings) {
    if (finding.status !== "still_blocking") continue;
    blockingMap.set(finding.id, {
      id: finding.id,
      source: finding.source,
      text: finding.note,
    });
  }

  for (const finding of [
    ...input.codeReview.blockingFindings,
    ...input.securityAudit.blockingFindings,
  ]) {
    blockingMap.set(finding.id, finding);
  }

  const blockingFindings = [...blockingMap.values()];

  const lines = [
    "## Auto Review Metadata",
    `- Strategy: ${input.strategy}`,
    `- Review Iteration: ${input.iteration}`,
    "",
    "## Previous Findings",
    ...(previousFindings.length > 0
      ? previousFindings.map(formatCanonicalPreviousFindingLine)
      : ["- none"]),
    "",
    "## Blocking Findings",
    ...(blockingFindings.length > 0
      ? blockingFindings.map(formatCanonicalBlockingFindingLine)
      : ["- none"]),
    "",
    "## Advisories",
    ...(advisories.length > 0 ? advisories.map(formatCanonicalAdvisoryLine) : ["- none"]),
    "",
    "## Raw Code Review",
    input.rawCodeReview.trim() || "No code review output.",
    "",
    "## Raw Security Audit",
    input.rawSecurityAudit.trim() || "No security audit output.",
  ];

  return lines.join("\n");
}

export function parseStructuredReviewComments(
  reviewComments: string | null,
): ParsedStructuredReviewComments | null {
  const normalizedComments = reviewComments?.trim();
  if (!normalizedComments) return null;

  const sections = collectSections(normalizedComments);
  const metadataLines = normalizeListSection(sections.get("Auto Review Metadata"));
  const blockingItems = normalizeListSection(sections.get("Blocking Findings"));
  const advisoryItems = normalizeListSection(sections.get("Advisories"));
  const previousItems = normalizeListSection(sections.get("Previous Findings"));

  if (!metadataLines || !blockingItems || !advisoryItems || previousItems === null) {
    return null;
  }

  const strategyLine = metadataLines.find((line) => line.startsWith("Strategy: "));
  const iterationLine = metadataLines.find((line) => line.startsWith("Review Iteration: "));
  if (!strategyLine || !iterationLine) {
    return null;
  }

  const strategy = strategyLine.slice("Strategy: ".length).trim();
  if (strategy !== "full_re_review" && strategy !== "closure_first") {
    return null;
  }

  const iteration = Number.parseInt(iterationLine.slice("Review Iteration: ".length).trim(), 10);
  if (!Number.isFinite(iteration) || iteration < 1) {
    return null;
  }

  const previousFindings: AutoReviewPreviousFinding[] = [];
  for (const item of previousItems) {
    const match = item.match(
      /^\[([^\]]+)\]\s+(code_review|security_audit|review_gate)\s+\|\s+(resolved|still_blocking)\s+\|\s+(.+)$/,
    );
    if (!match) {
      return null;
    }
    previousFindings.push({
      id: match[1],
      source: match[2] as AutoReviewFindingSource,
      status: match[3] as AutoReviewPreviousFindingStatus,
      note: normalizeFindingText(match[4]),
      text: normalizeFindingText(match[4]),
    });
  }

  const blockingFindings: AutoReviewFinding[] = [];
  for (const item of blockingItems) {
    const match = item.match(
      /^\[([^\]]+)\]\s+(code_review|security_audit|review_gate)\s+\|\s+(.+)$/,
    );
    if (!match) {
      return null;
    }
    blockingFindings.push({
      id: match[1],
      source: match[2] as AutoReviewFindingSource,
      text: normalizeFindingText(match[3]),
    });
  }

  const advisories: AutoReviewAdvisory[] = [];
  for (const item of advisoryItems) {
    const match = item.match(/^(code_review|security_audit|review_gate)\s+\|\s+(.+)$/);
    if (!match) {
      return null;
    }
    advisories.push({
      source: match[1] as AutoReviewFindingSource,
      text: normalizeFindingText(match[2]),
    });
  }

  return {
    strategy,
    iteration,
    blockingFindings,
    advisories,
    previousFindings,
  };
}

export function toAutoReviewState(input: {
  strategy: AutoReviewStrategy;
  iteration: number;
  findings: AutoReviewFinding[];
}): AutoReviewState {
  return {
    strategy: input.strategy,
    iteration: input.iteration,
    findings: input.findings,
  };
}
