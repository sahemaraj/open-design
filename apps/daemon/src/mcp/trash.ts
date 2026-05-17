// Soft-delete (trash) mechanics for files removed via MCP write tools.
// See docs/internal/mcp-write-design.md §6.
//
// Split of responsibility (intentional):
//   - This module: compute the trash-relative path (pure function).
//   - write-tools.ts (HRG-16c): call computeTrashPath, then POST to the
//     daemon's `/api/projects/:id/files/rename` endpoint with the result.
//
// Keeping the path computation pure makes it trivially testable and avoids
// duplicating the daemon-call pattern that write-tools.ts will already own.

import * as path from 'node:path';

export interface TrashOptions {
  projectDir: string;
  relativePath: string;
}

export interface TrashResult {
  trashPath: string;
}

export function computeTrashPath(relativePath: string, now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/:/g, '-');
  const basename = path.basename(relativePath);
  return `.trash/${timestamp}-${basename}`;
}
