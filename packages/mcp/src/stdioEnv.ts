// MCP stdio transport reserves stdout for JSON-RPC — redirect logs to stderr.
// This module must be imported before any module that initialises the logger.
if (!process.env.LOG_DESTINATION) {
  process.env.LOG_DESTINATION = "stderr";
}
