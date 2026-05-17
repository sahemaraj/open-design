// MCP run tools (trigger and observe Open Design runs from an external agent).
// See docs/internal/mcp-write-design.md §3.
// TODO(HRG-17): implement.

import type { McpContext, McpToolRegistry } from './index.js';

export function registerRunTools(_registry: McpToolRegistry, _ctx: McpContext): void {
  // Intentionally empty. Tools registered in HRG-17.
}
