export interface ShutdownLogger {
  info: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface GracefulShutdownOptions {
  logger: ShutdownLogger;
  stopCodexIndex: () => Promise<void>;
  closeWebSockets: () => void;
  closeServer: () => void;
  exitProcess: (code: number) => void;
}

export function createGracefulShutdownHandler(
  options: GracefulShutdownOptions,
): (signal: string) => Promise<void> {
  let shuttingDown = false;

  return async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    options.logger.info(
      { signal },
      "Shutdown signal received - stopping Codex indexer, terminating WS + exiting",
    );

    try {
      await options.stopCodexIndex();
      options.logger.debug?.({ signal }, "Codex indexer stopped during shutdown");
    } catch (error) {
      options.logger.warn?.({ err: error, signal }, "Codex indexer shutdown failed");
    } finally {
      closeAndExit(options);
    }
  };
}

function closeAndExit(options: GracefulShutdownOptions): void {
  try {
    options.closeWebSockets();
  } finally {
    try {
      options.closeServer();
    } finally {
      options.exitProcess(0);
    }
  }
}
