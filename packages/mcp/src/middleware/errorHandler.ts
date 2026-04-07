import { logger } from "@aif/shared";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const log = logger("mcp:error");

/**
 * Map common error types to MCP error codes.
 */
export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }

  if (error instanceof Error) {
    // Validation errors
    if (error.message.includes("validation") || error.message.includes("invalid")) {
      log.error({ error: error.message }, "Validation error");
      return new McpError(ErrorCode.InvalidParams, error.message);
    }

    // Not found errors
    if (error.message.includes("not found")) {
      log.error({ error: error.message }, "Resource not found");
      return new McpError(ErrorCode.InvalidParams, error.message);
    }

    // Generic errors
    log.error({ error: error.message, stack: error.stack }, "Unhandled tool exception");
    return new McpError(ErrorCode.InternalError, error.message);
  }

  log.error({ error: String(error) }, "Unknown error type");
  return new McpError(ErrorCode.InternalError, String(error));
}

/**
 * Create an MCP error for rate limiting.
 */
export function rateLimitError(toolName: string): McpError {
  return new McpError(
    ErrorCode.InvalidRequest,
    `Rate limit exceeded for tool: ${toolName}. Please wait before retrying.`,
  );
}

/**
 * Create an MCP error for validation failures with field-level detail.
 */
export function validationError(message: string, fieldErrors?: Record<string, string[]>): McpError {
  const detail = fieldErrors ? ` Fields: ${JSON.stringify(fieldErrors)}` : "";
  log.error({ message, fieldErrors }, "Validation failure");
  return new McpError(ErrorCode.InvalidParams, `${message}${detail}`);
}
