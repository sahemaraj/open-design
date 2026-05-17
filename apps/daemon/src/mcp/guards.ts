// Folder-import policy guards (path traversal, project scoping, allowed roots)
// plus the shared callDaemon helper used by write tools.
// See docs/internal/mcp-write-design.md §2.

import type { McpContext } from './index.js';
import { makeError, type McpWriteErrorCode } from './errors.js';

export interface ProjectRecord {
  id: string;
  name: string;
  metadata: Record<string, unknown> | null;
  resolvedDir?: string | null;
}

interface ProjectPayloadShape {
  project?: Partial<ProjectRecord> & { metadata?: Record<string, unknown> | null };
  resolvedDir?: string | null;
  id?: string;
  name?: string;
  metadata?: Record<string, unknown> | null;
}

export interface DaemonRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  // Status-aware overrides. Callers know whether a 404 means
  // PROJECT_NOT_FOUND vs FILE_NOT_FOUND better than this helper can
  // infer from the path string. K1: the issue spec proposed path-based
  // inference; explicit param is less brittle and lets assertProjectExists
  // stay as a thin wrapper while write-tools probes use FILE_NOT_FOUND.
  notFoundCode?: McpWriteErrorCode;
}

// Calls the local daemon and maps HTTP status / network failure to typed
// McpWriteError. Returns parsed JSON on 2xx (or null for empty body).
// Throws the McpWriteError envelope on any failure.
export async function callDaemon(
  ctx: McpContext,
  request: DaemonRequest,
): Promise<unknown> {
  const { method, path, body, query, notFoundCode } = request;
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${ctx.baseUrl}${path}${qs}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    throw makeError(
      'DAEMON_UNREACHABLE',
      `cannot reach daemon at ${ctx.baseUrl}: ${errMsg(err)}`,
      { details: { url, method } },
    );
  }

  if (resp.status === 404) {
    const code = notFoundCode ?? inferNotFoundCode(path);
    const text = await safeText(resp);
    throw makeError(code, `daemon 404 on ${method} ${path}: ${text || resp.statusText}`, {
      daemon_status: 404,
      details: { url, method },
    });
  }
  if (resp.status >= 500) {
    const text = await safeText(resp);
    throw makeError('DAEMON_5XX', `daemon ${resp.status} on ${method} ${path}: ${text || resp.statusText}`, {
      daemon_status: resp.status,
      details: { url, method },
    });
  }
  if (!resp.ok) {
    const parsed = await safeJson(resp);
    const text = parsed === null ? await safeText(resp) : '';
    throw makeError(
      'DAEMON_4XX',
      `daemon ${resp.status} on ${method} ${path}: ${text || (parsed ? JSON.stringify(parsed) : resp.statusText)}`,
      {
        daemon_status: resp.status,
        details: { url, method, body: parsed ?? text },
      },
    );
  }

  // 2xx — parse JSON; empty body returns null.
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Best-effort fallback when the caller doesn't pass notFoundCode.
// `/api/projects/<id>` alone → project; anything deeper → file.
function inferNotFoundCode(path: string): McpWriteErrorCode {
  const m = path.match(/^\/api\/projects\/[^/]+(\/.*)?$/);
  if (m && m[1]) return 'FILE_NOT_FOUND';
  return 'PROJECT_NOT_FOUND';
}

export async function assertProjectExists(
  ctx: McpContext,
  projectId: string,
): Promise<ProjectRecord> {
  const data = (await callDaemon(ctx, {
    method: 'GET',
    path: `/api/projects/${encodeURIComponent(projectId)}`,
    notFoundCode: 'PROJECT_NOT_FOUND',
  })) as ProjectPayloadShape | null;
  const raw = data?.project ?? data ?? {};
  const id = typeof raw?.id === 'string' ? raw.id : projectId;
  const name = typeof raw?.name === 'string' ? raw.name : '';
  const metadata = (raw?.metadata ?? null) as Record<string, unknown> | null;
  const resolvedDir = typeof data?.resolvedDir === 'string' ? data.resolvedDir : null;
  return { id, name, metadata, resolvedDir };
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

async function safeJson(resp: Response): Promise<unknown | null> {
  try {
    return await resp.clone().json();
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
