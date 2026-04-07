import { logger } from "./logger.js";

const log = logger("sync");

// ── Sync Types ──────────────────────────────────────────────

export type SyncDirection = "aif_to_handoff" | "handoff_to_aif";

export interface ConflictResolution {
  applied: boolean;
  conflict: boolean;
  winner: "source" | "target" | null;
  sourceTimestamp: string;
  targetTimestamp: string;
  field: string;
}

export interface SyncEvent {
  type: "sync:task_created" | "sync:task_updated" | "sync:status_changed" | "sync:plan_pushed";
  taskId: string;
  direction: SyncDirection;
  timestamp: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  conflictResolution?: ConflictResolution;
}

// ── Plan Annotation Types ───────────────────────────────────

export interface PlanAnnotation {
  taskId: string;
  line: number;
}

// ── Plan Annotation Utilities ───────────────────────────────

/** Regex to match plan annotations: <!-- handoff:task:<uuid> --> */
const ANNOTATION_REGEX =
  /<!--\s*handoff:task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*-->/gi;

/**
 * Parse all handoff task annotations from plan markdown.
 * Returns array of { taskId, line } sorted by line number.
 */
export function parsePlanAnnotations(markdown: string): PlanAnnotation[] {
  const annotations: PlanAnnotation[] = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    // Reset regex lastIndex for each line
    const regex = new RegExp(ANNOTATION_REGEX.source, "gi");
    while ((match = regex.exec(line)) !== null) {
      annotations.push({ taskId: match[1], line: i + 1 });
    }
  }

  log.debug({ count: annotations.length }, "Parsed plan annotations");
  return annotations;
}

/**
 * Insert a handoff task annotation into plan markdown.
 * If sectionHeading is provided, inserts after the first line matching that heading.
 * If no heading specified or not found, inserts at the top of the document.
 * If an annotation for this taskId already exists, updates its position.
 */
export function insertPlanAnnotation(
  markdown: string,
  taskId: string,
  sectionHeading?: string,
): string {
  const annotation = `<!-- handoff:task:${taskId} -->`;

  // Remove existing annotation for this taskId if present
  const existingRegex = new RegExp(
    `<!--\\s*handoff:task:${taskId.replace(/-/g, "\\-")}\\s*-->\\n?`,
    "gi",
  );
  const hasExisting = existingRegex.test(markdown);
  let cleaned = markdown.replace(existingRegex, "");

  if (hasExisting) {
    log.warn({ taskId }, "Duplicate annotation found and resolved");
  }

  const lines = cleaned.split("\n");

  if (sectionHeading) {
    // Find the heading line
    const headingIndex = lines.findIndex((line) => {
      const trimmed = line.trim();
      // Match markdown headings: # Heading, ## Heading, etc.
      const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
      return headingMatch && headingMatch[1].trim() === sectionHeading.trim();
    });

    if (headingIndex !== -1) {
      lines.splice(headingIndex + 1, 0, annotation);
      log.debug(
        { taskId, line: headingIndex + 2, sectionHeading },
        "Inserted annotation after heading",
      );
    } else {
      // Heading not found, insert at top
      lines.unshift(annotation);
      log.debug({ taskId, line: 1 }, "Section heading not found, inserted annotation at top");
    }
  } else {
    // No heading specified, insert at top
    lines.unshift(annotation);
    log.debug({ taskId, line: 1 }, "Inserted annotation at top");
  }

  return lines.join("\n");
}
