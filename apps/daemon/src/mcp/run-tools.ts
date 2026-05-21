// MCP run tools: trigger_run, cancel_run, list_runs.
// See docs/internal/mcp-write-design.md §3.

import type { McpContext, McpToolHandler, McpToolRegistry } from './index.js';
import { isMcpWriteError, makeError } from './errors.js';
import { assertProjectExists, type DaemonRequest } from './guards.js';
import { checkAndRecord, recordCompletion } from './rate-limit.js';

const RUN_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

interface TriggerRunArgs {
  project_id?: unknown;
  conversation_id?: unknown;
  prompt?: unknown;
  agent_id?: unknown;
  model?: unknown;
  skill_id?: unknown;
  design_system_id?: unknown;
  attachments?: unknown;
}
interface CancelRunArgs { run_id?: unknown }
interface ListRunsArgs { project_id?: unknown; limit?: unknown }

// runId → projectId so cancel_run can decrement the concurrent counter
// for the right project (the daemon's cancel endpoint is keyed only by
// runId). K1 caveat: completion-by-cancel is the only signal we observe;
// runs that complete naturally never decrement (no SSE drain in v1).
const runToProject = new Map<string, string>();

export function registerRunTools(registry: McpToolRegistry, ctx: McpContext): void {
  registry.add(
    {
      name: 'trigger_run',
      description: 'Trigger a new Open Design run (wraps POST /api/runs). Returns immediately with {run_id}; does NOT block on completion, does NOT poll, does NOT auto-commit. Files written during the run fold into the next MCP commit.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          conversation_id: { type: 'string' },
          prompt: { type: 'string' },
          agent_id: { type: 'string' },
          model: { type: 'string' },
          skill_id: { type: 'string' },
          design_system_id: { type: 'string' },
          attachments: { type: 'array' },
        },
        required: ['project_id', 'conversation_id', 'prompt'],
        additionalProperties: false,
      },
      annotations: { ...RUN_ANNOTATIONS, title: 'Trigger run' },
    },
    asResponse((_name, raw) => handleTriggerRun(ctx, raw as TriggerRunArgs)),
  );

  registry.add(
    {
      name: 'cancel_run',
      description: 'Cancel a running Open Design run (wraps POST /api/runs/:id/cancel).',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'string' } },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { ...RUN_ANNOTATIONS, title: 'Cancel run' },
    },
    asResponse((_name, raw) => handleCancelRun(ctx, raw as CancelRunArgs)),
  );

  registry.add(
    {
      name: 'list_runs',
      description: 'List runs for a project (wraps GET /api/runs?projectId=...).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['project_id'],
        additionalProperties: false,
      },
      annotations: { ...RUN_ANNOTATIONS, readOnlyHint: true, title: 'List runs' },
    },
    asResponse((_name, raw) => handleListRuns(ctx, raw as ListRunsArgs)),
  );
}

async function handleTriggerRun(ctx: McpContext, args: TriggerRunArgs): Promise<unknown> {
  const projectId = requireString(args.project_id, 'project_id');
  const conversationId = requireString(args.conversation_id, 'conversation_id');
  const prompt = requireString(args.prompt, 'prompt');
  const agentId = optionalString(args.agent_id, 'agent_id');
  const model = optionalString(args.model, 'model');
  const skillId = optionalString(args.skill_id, 'skill_id');
  const designSystemId = optionalString(args.design_system_id, 'design_system_id');
  const attachments = Array.isArray(args.attachments) ? args.attachments : undefined;

  // Per design §3: trigger_run is the lone exception to the folder-import
  // refusal — runs don't auto-commit, so no git side-effect on baseDir
  // projects. Intentionally NOT calling assertNotBaseDirProject here.
  await assertProjectExists(ctx, projectId);

  const check = checkAndRecord(projectId);
  if (!check.allowed) {
    const extras: Record<string, unknown> = {
      details: {
        project_id: projectId,
        dimension: check.exceeded_dimension,
        current_count: check.current_count,
      },
    };
    if (check.exceeded_dimension !== undefined) extras.exceeded_dimension = check.exceeded_dimension;
    if (check.retry_after_seconds !== undefined) extras.retry_after_seconds = check.retry_after_seconds;
    throw makeError(
      'RATE_LIMIT_EXCEEDED',
      `trigger_run rate limit exceeded for project ${projectId} (dimension: ${check.exceeded_dimension})`,
      extras,
    );
  }

  const body: Record<string, unknown> = {
    projectId,
    conversationId,
    message: prompt,
  };
  if (agentId !== undefined) body.agentId = agentId;
  if (model !== undefined) body.model = model;
  if (skillId !== undefined) body.skillId = skillId;
  if (designSystemId !== undefined) body.designSystemId = designSystemId;
  if (attachments !== undefined) body.attachments = attachments;

  let resp: { runId?: unknown; appliedPluginSnapshotId?: unknown; pluginId?: unknown } | null;
  try {
    resp = (await callDaemonWithHeader(ctx, {
      method: 'POST',
      path: '/api/runs',
      body,
    })) as typeof resp;
  } catch (err) {
    // Slot was reserved by checkAndRecord; refund the concurrent counter
    // since the run never actually started on the daemon.
    recordCompletion(projectId);
    throw err;
  }

  const runId = typeof resp?.runId === 'string' ? resp.runId : '';
  if (runId) runToProject.set(runId, projectId);

  return {
    run_id: runId,
    ...(typeof resp?.appliedPluginSnapshotId === 'string'
      ? { applied_plugin_snapshot_id: resp.appliedPluginSnapshotId }
      : {}),
    ...(typeof resp?.pluginId === 'string' ? { plugin_id: resp.pluginId } : {}),
  };
}

async function handleCancelRun(ctx: McpContext, args: CancelRunArgs): Promise<unknown> {
  const runId = requireString(args.run_id, 'run_id');
  await callDaemonWithHeader(ctx, {
    method: 'POST',
    path: `/api/runs/${encodeURIComponent(runId)}/cancel`,
  });
  const projectId = runToProject.get(runId);
  if (projectId) {
    recordCompletion(projectId);
    runToProject.delete(runId);
  }
  return { ok: true };
}

async function handleListRuns(ctx: McpContext, args: ListRunsArgs): Promise<unknown> {
  const projectId = requireString(args.project_id, 'project_id');
  await assertProjectExists(ctx, projectId);
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;

  const resp = (await callDaemonWithHeader(ctx, {
    method: 'GET',
    path: '/api/runs',
    query: { projectId },
  })) as { runs?: unknown[] } | null;

  let runs = Array.isArray(resp?.runs) ? resp!.runs : [];
  if (limit !== undefined && runs.length > limit) runs = runs.slice(0, limit);
  return { runs };
}

// Variant of callDaemon that stamps `x-od-client: mcp` per design §3.
// guards.callDaemon does not expose a headers param, so this is a
// minimal local copy that does. Error mapping mirrors guards.callDaemon
// for envelope consistency.
async function callDaemonWithHeader(ctx: McpContext, req: DaemonRequest): Promise<unknown> {
  const { method, path, body, query } = req;
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${ctx.baseUrl}${path}${qs}`;
  const headers: Record<string, string> = { 'x-od-client': 'mcp' };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    throw makeError(
      'DAEMON_UNREACHABLE',
      `cannot reach daemon at ${ctx.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      { details: { url, method } },
    );
  }

  if (resp.status === 404) {
    const text = await safeText(resp);
    throw makeError(req.notFoundCode ?? 'PROJECT_NOT_FOUND', `daemon 404 on ${method} ${path}: ${text || resp.statusText}`, {
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
    const text = await safeText(resp);
    throw makeError('DAEMON_4XX', `daemon ${resp.status} on ${method} ${path}: ${text || resp.statusText}`, {
      daemon_status: resp.status,
      details: { url, method },
    });
  }

  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function safeText(resp: Response): Promise<string> {
  try { return await resp.text(); } catch { return ''; }
}

function asResponse(
  fn: (name: string, args: Record<string, unknown> | undefined) => Promise<unknown>,
): McpToolHandler {
  return async (name, args) => {
    let payload: unknown;
    try {
      payload = await fn(name, args);
    } catch (err) {
      if (isMcpWriteError(err)) payload = err;
      else throw err;
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  };
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw makeError('INVALID_PATH', `${field} is required (non-empty string)`);
  }
  return v;
}
function optionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw makeError('INVALID_PATH', `${field} must be a string`);
  return v;
}
