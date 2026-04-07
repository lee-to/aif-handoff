/** Generic stderr ring-buffer collector for runtime subprocess output. */
export interface StderrCollector {
  onStderr: (chunk: string) => void;
  getTail: () => string;
}

export function createStderrCollector(maxLines = 20): StderrCollector {
  const lines: string[] = [];

  return {
    onStderr: (chunk: string) => {
      for (const rawLine of chunk.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    getTail: () => lines.join(" | "),
  };
}
