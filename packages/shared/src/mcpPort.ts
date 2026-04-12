export type ParsedMcpPortSetting =
  | { status: "unset" }
  | { status: "valid"; value: string; port: number }
  | { status: "invalid"; value: string };

export function parseMcpPortSetting(value: string | undefined): ParsedMcpPortSetting {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { status: "unset" };
  }

  const port = Number(trimmed);
  if (Number.isInteger(port) && port > 0 && port <= 65_535) {
    return { status: "valid", value: String(port), port };
  }

  return { status: "invalid", value: trimmed };
}
