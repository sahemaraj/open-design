// `od mcp` - stdio MCP server that proxies tool calls to the running
// daemon's HTTP API. Lets a coding agent in a *different* repo
// (Claude Code, Cursor, Zed) pull files from a local Open Design
// project without the export-zip-import dance.
//
// The server itself holds no state and never touches the filesystem;
// every tool resolves to a fetch() against `OD_DAEMON_URL`. Spawn the
// MCP server with no daemon running and tool calls return a clear
// "daemon not reachable" error - the server itself still launches so
// the client can list its tool schema.
//
// Module layout: see docs/internal/mcp-write-design.md §8.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { listReadResources, readReadResource, registerReadTools } from './read-tools.js';
import { registerWriteTools } from './write-tools.js';
import { registerRunTools } from './run-tools.js';
import { registerCatalogTools } from './catalog-tools.js';

const SERVER_NAME = 'open-design';
const SERVER_VERSION = '0.2.0';

interface RunMcpOptions { daemonUrl: string | URL }
interface ErrorWithCode { message?: string; code?: string; cause?: { code?: string } }

// Shared context passed to every register* function. Currently just
// the daemon base URL; future fields (auth tokens, etc.) land here.
export interface McpContext {
  baseUrl: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
}

// Each register function's handler receives the tool name plus its
// arguments. The name passthrough lets a single handler service
// multiple tools via switch (as the read tools do today).
export type McpToolHandler = (name: string, args: Record<string, unknown> | undefined) => Promise<unknown>;

export interface McpToolRegistry {
  add(def: McpToolDef, handler: McpToolHandler): void;
}

interface RegisteredTool { def: McpToolDef; handler: McpToolHandler }

class ToolRegistryImpl implements McpToolRegistry {
  readonly tools: RegisteredTool[] = [];
  add(def: McpToolDef, handler: McpToolHandler): void {
    this.tools.push({ def, handler });
  }
}

export async function runMcpStdio({ daemonUrl }: RunMcpOptions): Promise<void> {
  const baseUrl = String(daemonUrl).replace(/\/$/, '');
  const ctx: McpContext = { baseUrl };

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: [
        'Open Design (OD) is a local-first design workspace. The user typically',
        'has OD running on their machine; each project contains a rendered',
        'artifact (HTML/JSX/CSS) plus its source files.',
        '',
        'Active context: get_artifact, get_project, get_file, search_files,',
        'and list_files all accept project as OPTIONAL. When omitted, they',
        'default to the project the user has open in OD right now; get_file',
        'and get_artifact additionally default to the active file. So when',
        'the user says "this file" / "the design I have open" / "find X",',
        'just call the tool without project - no need to ask first. The',
        'response carries usedActiveContext so you can confirm which',
        'project/file you hit. Pass project explicitly to override.',
        '',
        'Pulling design context:',
        ' - get_artifact() - entry file PLUS every referenced sibling',
        '    (tokens CSS, JSX modules, imported assets) in one call.',
        '    PREFER THIS over multiple get_file calls when the user',
        '    wants to understand or extend a design.',
        ' - get_file(path) for a single known file. Returns up to 2000',
        '    lines starting at offset (default 0) and stamps a',
        '    [od:file-window ...] marker when the file is longer; page',
        '    by re-calling with the next offset.',
        ' - search_files(query) to find a class/component/copy string',
        '    without fetching every file.',
        ' - list_files for metadata only.',
        ' - list_projects to discover what is available on this daemon.',
        ' - get_active_context() if you want the active project/file',
        '    explicitly without making any other tool call.',
        '',
        'Project arguments accept either a UUID or a name substring',
        '(e.g. "recaptr"); the server resolves the latter. When a project',
        'is matched by slug or substring the response carries',
        'resolvedProject:{id,name} so you can confirm which project was',
        'resolved. Verify with the user if the match was unexpected.',
        '',
        'Reference material is exposed as MCP resources, not tools - read',
        'od://design-systems/<id>/DESIGN.md when you need the brand spec',
        'for a design (palette, typography, voice). Skills are similarly',
        'available at od://skills/<id>/SKILL.md but are mostly relevant',
        'when the user asks about how a particular artifact was generated.',
        '',
        'When extending an Open Design design in another codebase, pull',
        'the full bundle once with get_artifact and work from those files',
        'locally - do not fetch files one-by-one if you can avoid it.',
      ].join('\n'),
    },
  );

  const registry = new ToolRegistryImpl();
  registerReadTools(registry, ctx);
  registerWriteTools(registry, ctx);
  registerRunTools(registry, ctx);
  registerCatalogTools(registry, ctx);

  const handlerByName = new Map<string, McpToolHandler>();
  for (const { def, handler } of registry.tools) {
    handlerByName.set(def.name, handler);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.tools.map((t) => t.def),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => listReadResources(baseUrl));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
    readReadResource(baseUrl, req.params?.uri),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params?.name as string | undefined;
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    const handler = name ? handlerByName.get(name) : undefined;
    if (!handler) {
      return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
    }
    try {
      return (await handler(name!, args)) as { content: unknown[] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: formatError(err, baseUrl) }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // server.connect() only *starts* the transport; it resolves once the
  // stdio reader is wired up, not when the stream closes. Hold the
  // process open until the client disconnects (stdin EOF) so the cli.ts
  // top-level `process.exit(0)` doesn't kill us mid-handshake.
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    transport.onclose = done;
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
}

function formatError(err: unknown, daemonUrl: string): string {
  const e = err as ErrorWithCode | null | undefined;
  const code = e && (e.cause?.code || e.code);
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return `cannot reach the Open Design daemon at ${daemonUrl}. Is it running? Start it with \`pnpm tools-dev\`.`;
  }
  return msg;
}

// Re-export read-tools test symbols for backward-compat with existing
// unit tests that import from '../src/mcp.js'. See apps/daemon/tests/mcp-*.test.ts.
export {
  extractRelativeRefs,
  resolveProjectId,
  resolveProjectArg,
  withActiveEcho,
  fetchProjectFile,
  getArtifact,
  getFile,
} from './read-tools.js';
