// MCP write tools (create_file, update_file, rename_file, soft_delete_file, create_project).
// See docs/internal/mcp-write-design.md §1.
// TODO(HRG-16): implement.

import type { McpContext, McpToolRegistry } from './index.js';

export function registerWriteTools(_registry: McpToolRegistry, _ctx: McpContext): void {
  // Intentionally empty. Tools registered in HRG-16.
}
