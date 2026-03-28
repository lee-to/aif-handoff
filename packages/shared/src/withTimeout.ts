/**
 * Race a promise against a timeout. Cleans up the timer on resolution
 * so it never keeps the Node.js event loop alive after the work is done.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
        // Don't let the timer keep Node.js alive on its own
        if (typeof timeoutId === "object" && "unref" in timeoutId) {
          timeoutId.unref();
        }
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
