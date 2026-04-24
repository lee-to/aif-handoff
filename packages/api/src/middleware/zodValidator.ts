import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

/**
 * Typed JSON body validator for Hono routes.
 * Wraps @hono/zod-validator's zValidator with "json" target.
 * The double-cast resolves the Zod v3/v4 generic mismatch that makes
 * the direct call fail on stricter TypeScript configurations.
 */
export function jsonValidator<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("json", schema as any);
}

/**
 * Typed query validator for Hono routes.
 * Wraps @hono/zod-validator's zValidator with "query" target.
 */
export function queryValidator<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("query", schema as any);
}
