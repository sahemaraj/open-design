// Unit tests for MCP write tools (HRG-16c).
// Exercises registerWriteTools through a captured registry so we don't
// boot the real MCP stdio server. Daemon HTTP is faked via express.
//
// safeCommit is exercised in its no-resolvedDir branch (returns warning
// without invoking git) so tests stay hermetic — no tmp git repo,
// no execFile on the host's git binary.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerWriteTools } from '../src/mcp/write-tools.js';
import type {
  McpContext,
  McpToolDef,
  McpToolHandler,
  McpToolRegistry,
} from '../src/mcp/index.js';

const PROJECT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BASE_DIR_PROJECT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface Harness {
  server: http.Server;
  baseUrl: string;
}

interface RegisteredTool { def: McpToolDef; handler: McpToolHandler }

class CaptureRegistry implements McpToolRegistry {
  readonly tools: RegisteredTool[] = [];
  add(def: McpToolDef, handler: McpToolHandler): void {
    this.tools.push({ def, handler });
  }
  get(name: string): McpToolHandler {
    const t = this.tools.find((x) => x.def.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t.handler;
  }
}

interface DaemonOverrides {
  createProject?: (body: unknown) => unknown;
  getProject?: (id: string) => { status?: number; body?: unknown };
  postFiles?: (id: string, body: unknown) => { status?: number; body?: unknown };
  postRename?: (id: string, body: unknown) => { status?: number; body?: unknown };
  rawFile?: (id: string, path: string) => { status?: number; body?: string };
}

function makeDaemonApp(o: DaemonOverrides = {}): Express {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.post('/api/projects', (req, res) => {
    if (o.createProject) {
      res.json(o.createProject(req.body));
      return;
    }
    const { id, name } = req.body ?? {};
    res.json({ project: { id, name }, conversationId: 'conv-' + id });
  });

  app.get('/api/projects/:id', (req, res) => {
    const r = o.getProject?.(req.params.id) ?? defaultGetProject(req.params.id);
    res.status(r.status ?? 200).json(r.body ?? null);
  });

  app.post('/api/projects/:id/files', (req, res) => {
    const r = o.postFiles?.(req.params.id, req.body) ?? {
      status: 200,
      body: { file: { path: req.body?.name, size: 0 } },
    };
    res.status(r.status ?? 200).json(r.body ?? null);
  });

  app.post('/api/projects/:id/files/rename', (req, res) => {
    const r = o.postRename?.(req.params.id, req.body) ?? {
      status: 200,
      body: { file: { path: req.body?.to } },
    };
    res.status(r.status ?? 200).json(r.body ?? null);
  });

  app.get('/api/projects/:id/raw/*', (req, res) => {
    const path = (req.params as Record<string, string>)[0] ?? '';
    const r = o.rawFile?.(req.params.id, path) ?? { status: 404, body: '' };
    res.status(r.status ?? 200).send(r.body ?? '');
  });

  return app;
}

function defaultGetProject(id: string): { status?: number; body?: unknown } {
  if (id === BASE_DIR_PROJECT_ID) {
    return {
      body: {
        project: { id, name: 'folder-imported', metadata: { baseDir: '/some/dir' } },
        resolvedDir: null,
      },
    };
  }
  if (id === PROJECT_ID) {
    return {
      body: {
        project: { id, name: 'normal', metadata: {} },
        // resolvedDir null → safeCommit returns commit_warning without touching git.
        resolvedDir: null,
      },
    };
  }
  return { status: 404, body: { error: 'not found' } };
}

function startServer(app: Express): Promise<Harness> {
  return new Promise((resolve) => {
    const tmp = http.createServer();
    tmp.listen(0, '127.0.0.1', () => {
      const { port } = tmp.address() as AddressInfo;
      tmp.close(() => {
        const server = app.listen(port, '127.0.0.1', () =>
          resolve({ server, baseUrl: `http://127.0.0.1:${port}` }),
        );
      });
    });
  });
}

async function callTool(
  handler: McpToolHandler,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await handler(name, args)) as { content: Array<{ type: string; text: string }> };
  const txt = res.content[0]?.text ?? '{}';
  return JSON.parse(txt) as Record<string, unknown>;
}

function makeRegistry(baseUrl: string): { reg: CaptureRegistry; ctx: McpContext } {
  const ctx: McpContext = { baseUrl };
  const reg = new CaptureRegistry();
  registerWriteTools(reg, ctx);
  return { reg, ctx };
}

describe('registerWriteTools', () => {
  it('registers all 5 write tools with correct schemas', async () => {
    const { reg } = makeRegistry('http://127.0.0.1:1');
    const names = reg.tools.map((t) => t.def.name).sort();
    expect(names).toEqual([
      'create_file',
      'create_project',
      'rename_file',
      'soft_delete_file',
      'update_file',
    ]);
    for (const t of reg.tools) {
      expect(t.def.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
  });
});

describe('create_project', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startServer(makeDaemonApp());
  });
  afterEach(() => new Promise((resolve) => h.server.close(resolve)));

  it('returns ok with project_id, conversation_id, committed:false', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('create_project'), 'create_project', { name: 'My Proj' });
    expect(r.ok).toBe(true);
    expect(typeof r.project_id).toBe('string');
    expect(r.committed).toBe(false);
    expect(typeof r.conversation_id).toBe('string');
  });

  it('rejects missing name', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('create_project'), 'create_project', {});
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('INVALID_PATH');
  });

  it('forwards optional skill_id / design_system_id / pending_prompt', async () => {
    let captured: unknown;
    const app = makeDaemonApp({
      createProject: (body) => {
        captured = body;
        const b = body as { id: string; name: string };
        return { project: { id: b.id, name: b.name }, conversationId: 'c' };
      },
    });
    const local = await startServer(app);
    try {
      const { reg } = makeRegistry(local.baseUrl);
      await callTool(reg.get('create_project'), 'create_project', {
        name: 'X',
        skill_id: 'sk_1',
        design_system_id: 'ds_1',
        pending_prompt: 'hello',
      });
      expect(captured).toMatchObject({
        name: 'X',
        skillId: 'sk_1',
        designSystemId: 'ds_1',
        pendingPrompt: 'hello',
      });
    } finally {
      await new Promise((res) => local.server.close(res));
    }
  });
});

describe('create_file / update_file path + size validation', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startServer(makeDaemonApp());
  });
  afterEach(() => new Promise((resolve) => h.server.close(resolve)));

  it('rejects absolute path', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('create_file'), 'create_file', {
      project_id: PROJECT_ID,
      path: '/etc/passwd',
      content: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('INVALID_PATH');
  });

  it('rejects path traversal "..".', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('create_file'), 'create_file', {
      project_id: PROJECT_ID,
      path: 'foo/../../bar',
      content: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('INVALID_PATH');
  });

  it('rejects null byte in path', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('create_file'), 'create_file', {
      project_id: PROJECT_ID,
      path: 'foo\0bar',
      content: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('INVALID_PATH');
  });

  it('rejects invalid encoding', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('create_file'), 'create_file', {
      project_id: PROJECT_ID,
      path: 'a.txt',
      content: 'x',
      encoding: 'hex',
    });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('INVALID_PATH');
  });

  it('rejects content > 10MB (utf8)', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const big = 'a'.repeat(10 * 1024 * 1024 + 1);
    const r = await callTool(reg.get('create_file'), 'create_file', {
      project_id: PROJECT_ID,
      path: 'big.txt',
      content: big,
    });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('FILE_TOO_LARGE');
  });

  it('rejects base-dir (folder-imported) project', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('create_file'), 'create_file', {
      project_id: BASE_DIR_PROJECT_ID,
      path: 'a.txt',
      content: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('BASE_DIR_PROJECT_UNSUPPORTED');
  });

  it('happy path returns ok with commit_warning (no resolvedDir)', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('create_file'), 'create_file', {
      project_id: PROJECT_ID,
      path: 'foo/bar.txt',
      content: 'hello',
    });
    expect(r.ok).toBe(true);
    expect(r.committed).toBe(false);
    expect(typeof r.commit_warning).toBe('string');
    expect(r.file).toBeDefined();
  });

  it('update_file shares the same validation surface', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('update_file'), 'update_file', {
      project_id: PROJECT_ID,
      path: '/abs',
      content: 'x',
    });
    expect(r.error_code).toBe('INVALID_PATH');
  });
});

describe('5xx recovery enrichment', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startServer(makeDaemonApp({
      postFiles: () => ({ status: 500, body: { error: 'boom' } }),
      rawFile: (_id, path) =>
        path === 'foo/bar.txt'
          ? { status: 200, body: 'existing' }
          : { status: 404, body: '' },
    }));
  });
  afterEach(() => new Promise((resolve) => h.server.close(resolve)));

  it('attaches recovered_state.file_exists on DAEMON_5XX', async () => {
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('create_file'), 'create_file', {
      project_id: PROJECT_ID,
      path: 'foo/bar.txt',
      content: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('DAEMON_5XX');
    expect((r.recovered_state as { file_exists?: boolean }).file_exists).toBe(true);
  });
});

describe('rename_file', () => {
  let h: Harness;
  afterEach(() => h && new Promise((resolve) => h.server.close(resolve)));

  it('rejects invalid from/to', async () => {
    h = await startServer(makeDaemonApp());
    const { reg } = makeRegistry(h.baseUrl);
    const r1 = await callTool(reg.get('rename_file'), 'rename_file', {
      project_id: PROJECT_ID,
      from: '/abs',
      to: 'ok',
    });
    expect(r1.error_code).toBe('INVALID_PATH');
    const r2 = await callTool(reg.get('rename_file'), 'rename_file', {
      project_id: PROJECT_ID,
      from: 'ok',
      to: '../escape',
    });
    expect(r2.error_code).toBe('INVALID_PATH');
  });

  it('happy path echoes daemon file', async () => {
    h = await startServer(makeDaemonApp());
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('rename_file'), 'rename_file', {
      project_id: PROJECT_ID,
      from: 'a.txt',
      to: 'b.txt',
    });
    expect(r.ok).toBe(true);
    expect((r.file as { path?: string }).path).toBe('b.txt');
  });

  it('5xx enrich with from_exists / to_exists', async () => {
    h = await startServer(makeDaemonApp({
      postRename: () => ({ status: 500, body: { error: 'boom' } }),
      rawFile: (_id, p) =>
        p === 'a.txt' ? { status: 200, body: 'x' } : { status: 404, body: '' },
    }));
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('rename_file'), 'rename_file', {
      project_id: PROJECT_ID,
      from: 'a.txt',
      to: 'b.txt',
    });
    expect(r.error_code).toBe('DAEMON_5XX');
    const rec = r.recovered_state as { from_exists?: boolean; to_exists?: boolean };
    expect(rec.from_exists).toBe(true);
    expect(rec.to_exists).toBe(false);
  });
});

describe('soft_delete_file', () => {
  let h: Harness;
  afterEach(() => h && new Promise((resolve) => h.server.close(resolve)));

  it('uses daemon-echoed trash_path (daemon sanitizes leading dot)', async () => {
    h = await startServer(makeDaemonApp({
      postRename: (_id, body) => {
        const to = (body as { to: string }).to;
        // simulate daemon sanitizeName stripping leading "."
        const sanitized = to.replace(/^\.trash\//, '_trash/');
        return { status: 200, body: { file: { path: sanitized } } };
      },
    }));
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('soft_delete_file'), 'soft_delete_file', {
      project_id: PROJECT_ID,
      path: 'foo.txt',
    });
    expect(r.ok).toBe(true);
    expect(typeof r.trash_path).toBe('string');
    expect((r.trash_path as string).startsWith('_trash/')).toBe(true);
    expect((r.trash_path as string).endsWith('-foo.txt')).toBe(true);
  });

  it('errors DAEMON_5XX when daemon omits file.path', async () => {
    h = await startServer(makeDaemonApp({
      postRename: () => ({ status: 200, body: { file: {} } }),
    }));
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('soft_delete_file'), 'soft_delete_file', {
      project_id: PROJECT_ID,
      path: 'foo.txt',
    });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('DAEMON_5XX');
  });

  it('rejects invalid path', async () => {
    h = await startServer(makeDaemonApp());
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('soft_delete_file'), 'soft_delete_file', {
      project_id: PROJECT_ID,
      path: '../escape',
    });
    expect(r.error_code).toBe('INVALID_PATH');
  });

  it('rejects base-dir project', async () => {
    h = await startServer(makeDaemonApp());
    const { reg } = makeRegistry(h.baseUrl);
    const r = await callTool(reg.get('soft_delete_file'), 'soft_delete_file', {
      project_id: BASE_DIR_PROJECT_ID,
      path: 'foo.txt',
    });
    expect(r.error_code).toBe('BASE_DIR_PROJECT_UNSUPPORTED');
  });
});
