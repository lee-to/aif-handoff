import pino from "pino";
import "./loadEnv.js";

const level = process.env.LOG_LEVEL ?? "debug";

export function resolveLogDestination(env: NodeJS.ProcessEnv = process.env): 1 | 2 {
  const destination = env.LOG_DESTINATION?.trim().toLowerCase();
  return destination === "stderr" || destination === "2" ? 2 : 1;
}

export function resolveLogDestinationConfig(env: NodeJS.ProcessEnv = process.env): {
  dest: 1 | 2;
  sync: boolean;
} {
  return {
    dest: resolveLogDestination(env),
    sync: env.NODE_ENV !== "production",
  };
}

const rootLogger = pino({ level }, pino.destination(resolveLogDestinationConfig()));

/** Create a child logger with a component name */
export function logger(component: string): pino.Logger {
  return rootLogger.child({ component });
}

export { rootLogger };
