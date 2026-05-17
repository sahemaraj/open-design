// MCP write tools: create_project, create_file, update_file, rename_file, soft_delete_file.
// See docs/internal/mcp-write-design.md §1.

import { randomUUID } from 'node:crypto';

import type { McpContext, McpToolDef, McpToolHandler, McpToolRegistry } from './index.js';
import {
  isMcpWriteError,
  makeError,
  type McpWriteError,
} from './errors.js';
import {
  assertNotBaseDirProject,
  assertProjectExists,
  callDaemon,
  validateRelativePath,
  type ProjectRecord,
} from './guards.js';
import { autoCommit, type CommitResult } from './commit.js';
import { computeTrashPath } from './trash.js';

// 10 MB cap at the MCP boundary (design §9 Q3 / audit Q3).
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

interface CreateProjectArgs {
  name?: unknown;
  skill_id?: unknown;
  design_system_id?: unknown;
  pending_prompt?: unknown;
}
interface FileArgs {
  project_id?: unknown;
  path?: unknown;
  content?: unknown;
  encoding?: unknown;
}
interface RenameArgs {
  project_id?: unknown;
  from?: unknown;
  to?: unknown;
}
interface DeleteArgs {
  project_id?: unknown;
  path?: unknown;
}

export function registerWriteTools(registry: McpToolRegistry, ctx: McpContext): void {
  registry.add(
    {
      name: 'create_project',
      description: 'Create a new Open Design project. Returns {project_id, conversation_id, committed:false}. Auto-commit is skipped on create because no files exist yet; the first create_file bootstraps the per-project git repo.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          skill_id: { type: 'string' },
          design_system_id: { type: 'string' },
          pending_prompt: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: { ...WRITE_ANNOTATIONS, title: 'Create project' },
    },
    asResponse((_name, rawArgs) => handleCreateProject(ctx, rawArgs as CreateProjectArgs)),
  );

  registry.add(
    {
      name: 'create_file',
      description: 'Create a file in a project. Daemon endpoint is upsert; "create" vs "update" is caller intent. Auto-commits on success.',
      inputSchema: fileSchema('Path relative to project root.'),
      annotations: { ...WRITE_ANNOTATIONS, title: 'Create file' },
    },
    asResponse((_name, rawArgs) => handleWriteFile(ctx, rawArgs as FileArgs, 'create_file')),
  );

  registry.add(
    {
      name: 'update_file',
      description: 'Update an existing file in a project. Daemon endpoint is upsert; intent is caller-side only. Auto-commits on success.',
      inputSchema: fileSchema('Path relative to project root.'),
      annotations: { ...WRITE_ANNOTATIONS, title: 'Update file' },
    },
    asResponse((_name, rawArgs) => handleWriteFile(ctx, rawArgs as FileArgs, 'update_file')),
  );

  registry.add(
    {
      name: 'rename_file',
      description: 'Rename / move a file inside a project. Auto-commits on success.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['project_id', 'from', 'to'],
        additionalProperties: false,
      },
      annotations: { ...WRITE_ANNOTATIONS, title: 'Rename file' },
    },
    asResponse((_name, rawArgs) => handleRenameFile(ctx, rawArgs as RenameArgs)),
  );

  registry.add(
    {
      name: 'soft_delete_file',
      description: 'Soft-delete a file by moving it to .trash/<timestamp>-<basename>. No daemon DELETE call. Auto-commits the removal from the tracked tree.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['project_id', 'path'],
        additionalProperties: false,
      },
      annotations: { ...WRITE_ANNOTATIONS, title: 'Soft-delete file' },
    },
    asResponse((_name, rawArgs) => handleSoftDelete(ctx, rawArgs as DeleteArgs)),
  );
}

function fileSchema(pathDesc: string) {
  return {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      path: { type: 'string', description: pathDesc },
      content: { type: 'string' },
      encoding: { type: 'string', enum: ['utf8', 'base64'] },
    },
    required: ['project_id', 'path', 'content'],
    additionalProperties: false,
  };
}

// Wraps a handler so McpWriteError values are returned as JSON content
// (not thrown). Unexpected exceptions still bubble to the dispatcher.
function asResponse(
  fn: (name: string, args: Record<string, unknown> | undefined) => Promise<unknown>,
): McpToolHandler {
  return async (name, args) => {
    let payload: unknown;
    try {
      payload = await fn(name, args);
    } catch (err) {
      if (isMcpWriteError(err)) {
        payload = err;
      } else {
        throw err;
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  };
}

async function handleCreateProject(ctx: McpContext, args: CreateProjectArgs): Promise<unknown> {
  const name = requireString(args.name, 'name');
  const skillId = optionalString(args.skill_id, 'skill_id');
  const designSystemId = optionalString(args.design_system_id, 'design_system_id');
  const pendingPrompt = optionalString(args.pending_prompt, 'pending_prompt');

  // randomUUID() output matches /^[A-Za-z0-9._-]{1,128}$/ — no stripping.
  const id = randomUUID();
  const body: Record<string, unknown> = { id, name };
  if (skillId !== undefined) body.skillId = skillId;
  if (designSystemId !== undefined) body.designSystemId = designSystemId;
  if (pendingPrompt !== undefined) body.pendingPrompt = pendingPrompt;

  const resp = (await callDaemon(ctx, {
    method: 'POST',
    path: '/api/projects',
    body,
  })) as { project?: { id?: string }; conversationId?: string } | null;

  const projectId = resp?.project?.id ?? id;
  const conversationId = resp?.conversationId ?? '';
  // Auto-commit skipped: project create writes no files (audit §2). The
  // per-project git repo bootstraps on the first create_file call.
  return { ok: true, project_id: projectId, conversation_id: conversationId, committed: false };
}

async function handleWriteFile(
  ctx: McpContext,
  args: FileArgs,
  tool: 'create_file' | 'update_file',
): Promise<unknown> {
  const projectId = requireString(args.project_id, 'project_id');
  const path = validateRelativePath(requireString(args.path, 'path'));
  const content = requireString(args.content, 'content');
  const encoding = args.encoding === undefined ? 'utf8' : requireString(args.encoding, 'encoding');
  if (encoding !== 'utf8' && encoding !== 'base64') {
    throw makeError('INVALID_PATH', `encoding must be 'utf8' or 'base64' (got "${encoding}")`);
  }
  const decodedSize = encoding === 'base64'
    ? Buffer.byteLength(content, 'base64')
    : Buffer.byteLength(content, 'utf8');
  if (decodedSize > MAX_CONTENT_BYTES) {
    throw makeError('FILE_TOO_LARGE', `content exceeds ${MAX_CONTENT_BYTES} bytes (got ${decodedSize})`, {
      details: { path, size: decodedSize },
    });
  }

  const project = await assertProjectExists(ctx, projectId);
  assertNotBaseDirProject(project);

  let file: unknown;
  try {
    const resp = (await callDaemon(ctx, {
      method: 'POST',
      path: `/api/projects/${encodeURIComponent(projectId)}/files`,
      body: { name: path, content, encoding },
      notFoundCode: 'FILE_NOT_FOUND',
    })) as { file?: unknown } | null;
    file = resp?.file ?? resp;
  } catch (err) {
    if (isMcpWriteError(err) && err.error_code === 'DAEMON_5XX') {
      return enrichWithRecovery(err, { file_exists: await probeFileExists(ctx, projectId, path) });
    }
    throw err;
  }

  const commit = await safeCommit(project, tool, path);
  return { ok: true, file, ...commitFields(commit) };
}

async function handleRenameFile(ctx: McpContext, args: RenameArgs): Promise<unknown> {
  const projectId = requireString(args.project_id, 'project_id');
  const from = validateRelativePath(requireString(args.from, 'from'));
  const to = validateRelativePath(requireString(args.to, 'to'));

  const project = await assertProjectExists(ctx, projectId);
  assertNotBaseDirProject(project);

  let file: unknown;
  try {
    const resp = (await callDaemon(ctx, {
      method: 'POST',
      path: `/api/projects/${encodeURIComponent(projectId)}/files/rename`,
      body: { from, to },
      notFoundCode: 'FILE_NOT_FOUND',
    })) as { file?: unknown } | null;
    file = resp?.file ?? resp;
  } catch (err) {
    if (isMcpWriteError(err) && err.error_code === 'DAEMON_5XX') {
      const [fromExists, toExists] = await Promise.all([
        probeFileExists(ctx, projectId, from),
        probeFileExists(ctx, projectId, to),
      ]);
      return enrichWithRecovery(err, { from_exists: fromExists, to_exists: toExists });
    }
    throw err;
  }

  const commit = await safeCommit(project, 'rename_file', `${from} → ${to}`);
  return { ok: true, file, ...commitFields(commit) };
}

async function handleSoftDelete(ctx: McpContext, args: DeleteArgs): Promise<unknown> {
  const projectId = requireString(args.project_id, 'project_id');
  const path = validateRelativePath(requireString(args.path, 'path'));

  const project = await assertProjectExists(ctx, projectId);
  assertNotBaseDirProject(project);

  // Per design §6 the daemon's rename endpoint creates the target
  // parent directory via mkdir -p (audit §3.4), so `.trash/` materializes
  // lazily on the first soft-delete without a separate seed write.
  const trashPath = computeTrashPath(path);

  try {
    await callDaemon(ctx, {
      method: 'POST',
      path: `/api/projects/${encodeURIComponent(projectId)}/files/rename`,
      body: { from: path, to: trashPath },
      notFoundCode: 'FILE_NOT_FOUND',
    });
  } catch (err) {
    if (isMcpWriteError(err) && err.error_code === 'DAEMON_5XX') {
      const [origExists, trashExists] = await Promise.all([
        probeFileExists(ctx, projectId, path),
        probeFileExists(ctx, projectId, trashPath),
      ]);
      return enrichWithRecovery(err, {
        original_exists: origExists,
        trash_exists: trashExists,
      });
    }
    throw err;
  }

  const commit = await safeCommit(project, 'soft_delete_file', path);
  return { ok: true, trash_path: trashPath, ...commitFields(commit) };
}

async function safeCommit(
  project: ProjectRecord,
  tool: string,
  summary: string,
): Promise<{ result?: CommitResult; warning?: string }> {
  const projectDir = project.resolvedDir;
  if (!projectDir) {
    return { warning: 'no resolvedDir on project; commit skipped' };
  }
  try {
    const result = await autoCommit({ projectDir, tool, summary });
    return { result };
  } catch (err) {
    // Design §5: log a warning, do not error the MCP tool. Git is a
    // safety net, the daemon write already succeeded.
    const msg = isMcpWriteError(err)
      ? `${err.error_code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    console.warn(`[mcp-write] autoCommit failed for ${projectDir} (tool=${tool}): ${msg}`);
    return { warning: msg };
  }
}

function commitFields(c: { result?: CommitResult; warning?: string }) {
  if (!c.result) return { committed: false, ...(c.warning ? { commit_warning: c.warning } : {}) };
  return {
    committed: c.result.committed,
    ...(c.result.sha ? { sha: c.result.sha } : {}),
    ...(c.result.bootstrapped ? { bootstrapped: true } : {}),
  };
}

async function probeFileExists(ctx: McpContext, projectId: string, path: string): Promise<boolean> {
  const segments = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  try {
    const resp = await fetch(`${ctx.baseUrl}/api/projects/${encodeURIComponent(projectId)}/raw/${segments}`);
    return resp.ok;
  } catch {
    return false;
  }
}

function enrichWithRecovery(err: McpWriteError, recovered: Record<string, unknown>): McpWriteError {
  return { ...err, recovered_state: recovered };
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw makeError('INVALID_PATH', `${field} is required (non-empty string)`);
  }
  return v;
}

function optionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') {
    throw makeError('INVALID_PATH', `${field} must be a string`);
  }
  return v;
}
