// MCP catalog tools: read-only wrappers around the daemon's installed
// skills and design-systems lists. Lets an agent discover valid
// skill_id / design_system_id values for create_project and trigger_run
// without hardcoding. See docs/internal/mcp-write-design.md §1.

import { callDaemon } from './guards.js';
import type {
  McpContext,
  McpToolDef,
  McpToolHandler,
  McpToolRegistry,
} from './index.js';

interface RawCatalogEntry {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  summary?: unknown;
  source?: unknown;
  [k: string]: unknown;
}

interface NormalizedEntry {
  id: string;
  name: string;
  description?: string;
  source: 'built-in' | 'user';
  [k: string]: unknown;
}

interface SkillsResponse {
  skills?: RawCatalogEntry[];
}

interface DesignSystemsResponse {
  designSystems?: RawCatalogEntry[];
}

const CATALOG_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOL_DEFS: McpToolDef[] = [
  {
    name: 'list_skills',
    description:
      'List every installed design skill on this daemon (built-in plus user-installed). Use the returned id as the skill_id parameter on create_project or trigger_run. Call this before triggering a run to discover what skill_ids exist.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...CATALOG_ANNOTATIONS, title: 'List installed skills' },
  },
  {
    name: 'list_design_systems',
    description:
      'List every installed design system on this daemon (built-in plus user-installed). Use the returned id as the design_system_id parameter on create_project or trigger_run.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      ...CATALOG_ANNOTATIONS,
      title: 'List installed design systems',
    },
  },
];

export function registerCatalogTools(
  registry: McpToolRegistry,
  ctx: McpContext,
): void {
  const handler: McpToolHandler = async (name) => {
    switch (name) {
      case 'list_skills': {
        const data = (await callDaemon(ctx, {
          method: 'GET',
          path: '/api/skills',
        })) as SkillsResponse | null;
        const skills = (data?.skills ?? []).map(normalizeEntry);
        return ok({ skills });
      }
      case 'list_design_systems': {
        const data = (await callDaemon(ctx, {
          method: 'GET',
          path: '/api/design-systems',
        })) as DesignSystemsResponse | null;
        const design_systems = (data?.designSystems ?? []).map(normalizeEntry);
        return ok({ design_systems });
      }
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  };
  for (const def of TOOL_DEFS) registry.add(def, handler);
}

// Daemon already tags skill entries with `source: 'user' | 'built-in'`
// and design-system entries with `source: 'built-in' | 'installed'`.
// Normalize 'installed' → 'user' so both catalogs share the documented
// vocabulary. Pass through every other field (version, tags, etc.) so
// agents see the full daemon payload without us stripping data.
function normalizeEntry(raw: RawCatalogEntry): NormalizedEntry {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const name =
    typeof raw.name === 'string'
      ? raw.name
      : typeof raw.title === 'string'
      ? raw.title
      : id;
  const description =
    typeof raw.description === 'string'
      ? raw.description
      : typeof raw.summary === 'string'
      ? raw.summary
      : undefined;
  const rawSource = typeof raw.source === 'string' ? raw.source : '';
  const source: 'built-in' | 'user' =
    rawSource === 'built-in' ? 'built-in' : 'user';
  const { id: _id, name: _name, description: _d, source: _s, ...rest } = raw;
  const out: NormalizedEntry = { id, name, source, ...rest };
  if (description !== undefined) out.description = description;
  return out;
}

function ok(payload: unknown) {
  const text =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
