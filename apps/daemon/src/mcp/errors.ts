// Structured error envelopes and state-after-failure recovery for MCP write tools.
// See docs/internal/mcp-write-design.md §7.

export type McpWriteErrorCode =
  | 'BASE_DIR_PROJECT_UNSUPPORTED'
  | 'PROJECT_NOT_FOUND'
  | 'CONVERSATION_NOT_FOUND'
  | 'INVALID_PATH'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'RATE_LIMIT_EXCEEDED'
  | 'DAEMON_5XX'
  | 'DAEMON_4XX'
  | 'DAEMON_UNREACHABLE'
  | 'GIT_COMMIT_FAILED'
  | 'GIT_UNAVAILABLE'
  | 'NOT_IMPLEMENTED';

export interface McpWriteError {
  ok: false;
  error_code: McpWriteErrorCode;
  message: string;
  daemon_status?: number;
  recovered_state?: unknown;
  retry_after_seconds?: number;
  exceeded_dimension?: 'concurrent' | 'per_hour' | 'per_day';
  details?: Record<string, unknown>;
}

export function makeError(
  code: McpWriteErrorCode,
  message: string,
  extras?: Partial<Omit<McpWriteError, 'ok' | 'error_code' | 'message'>>,
): McpWriteError {
  return { ok: false, error_code: code, message, ...(extras ?? {}) };
}

export function isMcpWriteError(value: unknown): value is McpWriteError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.ok === false &&
    typeof v.error_code === 'string' &&
    typeof v.message === 'string'
  );
}
