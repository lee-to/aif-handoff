/** Bounded SSE decoder shared by the Runtime proxy and browser client. */
export async function* readSwarmSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let eventSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        eventSize += line.length;
        if (eventSize > 1_000_000) throw new Error("Swarm event exceeds size limit");
        if (!line) {
          if (data.length) yield data.join("\n");
          data = [];
          eventSize = 0;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (buffer.length > 1_000_000) throw new Error("Swarm event exceeds size limit");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
