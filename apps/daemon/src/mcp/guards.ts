// Folder-import policy guards (path traversal, project scoping, allowed roots).
// See docs/internal/mcp-write-design.md §2.

import type { McpContext } from './index.js';
import { makeError } from './errors.js';

export interface ProjectRecord {
  id: string;
  name: string;
  metadata: Record<string, unknown> | null;
}

interface ProjectPayloadShape {
  project?: Partial<ProjectRecord> & { metadata?: Record<string, unknown> | null };
  id?: string;
  name?: string;
  metadata?: Record<string, unknown> | null;
}

// Status-aware project fetch. read-tools.ts has a private getJson() but it
// collapses every non-2xx into a single Error string, which loses the
// 404-vs-5xx distinction we need to map onto PROJECT_NOT_FOUND / DAEMON_5XX.
// Rather than refactor the read-side helper, we do a minimal fetch here.
export async function assertProjectExists(
  ctx: McpContext,
  projectId: string,
): Promise<ProjectRecord> {
  const url = `${ctx.baseUrl}/api/projects/${encodeURIComponent(projectId)}`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw makeError('DAEMON_UNREACHABLE', `cannot reach daemon at ${ctx.baseUrl}: ${errMsg(err)}`, {
      details: { project_id: projectId },
    });
  }
  if (resp.status === 404) {
    throw makeError('PROJECT_NOT_FOUND', `no project with id "${projectId}"`, {
      daemon_status: 404,
      details: { project_id: projectId },
    });
  }
  if (resp.status >= 500) {
    const body = await safeText(resp);
    throw makeError('DAEMON_5XX', `daemon ${resp.status} on ${url}: ${body || resp.statusText}`, {
      daemon_status: resp.status,
      details: { project_id: projectId },
    });
  }
  if (!resp.ok) {
    const body = await safeText(resp);
    throw makeError('DAEMON_4XX', `daemon ${resp.status} on ${url}: ${body || resp.statusText}`, {
      daemon_status: resp.status,
      details: { project_id: projectId },
    });
  }
  const data = (await resp.json()) as ProjectPayloadShape;
  const raw = data?.project ?? data;
  const id = typeof raw?.id === 'string' ? raw.id : projectId;
  const name = typeof raw?.name === 'string' ? raw.name : '';
  const metadata = (raw?.metadata ?? null) as Record<string, unknown> | null;
  return { id, name, metadata };
}

export function assertNotBaseDirProject(project: ProjectRecord): void {
  const baseDir = project.metadata?.baseDir;
  if (baseDir !== undefined && baseDir !== null && baseDir !== '') {
    throw makeError(
      'BASE_DIR_PROJECT_UNSUPPORTED',
      `project "${project.name || project.id}" is folder-imported (baseDir set); write tools refuse to mutate folder-imported projects`,
      { details: { project_id: project.id, baseDir } },
    );
  }
}

export function validateRelativePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw makeError('INVALID_PATH', 'path is required (non-empty string)');
  }
  if (path.length > 1024) {
    throw makeError('INVALID_PATH', `path exceeds 1024 chars (got ${path.length})`, {
      details: { path },
    });
  }
  if (path.includes('\0')) {
    throw makeError('INVALID_PATH', 'path contains null byte', { details: { path } });
  }
  if (path.startsWith('/')) {
    throw makeError('INVALID_PATH', `path must be relative, not absolute: "${path}"`, {
      details: { path },
    });
  }
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw makeError('INVALID_PATH', `path traversal "..": "${path}"`, { details: { path } });
    }
  }
  return path;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
