# mcp-write tool surface design

Status: locked design, no implementation. Implementation lands in HRG-15+.
Branch: `feature/mcp-write`.
Source of truth for daemon behavior: [`docs/internal/daemon-write-surface.md`](./daemon-write-surface.md) (the HRG-13 audit). Every daemon claim below cites a section/line from that audit; this doc does not re-audit.

---

## 1. Tool inventory (v1)

The v1 MCP write surface is exactly the tools below. No more, no less.

All tools share a common typed-error envelope:

```ts
type McpError = {
  ok: false
  error_code:
    | 'BASE_DIR_PROJECT_UNSUPPORTED'
    | 'PROJECT_NOT_FOUND'
    | 'FILE_NOT_FOUND'
    | 'FILE_EXISTS'
    | 'INVALID_PATH'
    | 'INVALID_INPUT'
    | 'FILE_TOO_LARGE'
    | 'RATE_LIMIT_EXCEEDED'
    | 'RUN_NOT_FOUND'
    | 'RUN_TERMINAL'
    | 'DAEMON_ERROR'
    | 'DAEMON_UNREACHABLE'
  message: string
  daemon_status?: number          // HTTP status when daemon returned one
  recovered_state?: unknown       // see §7
  details?: Record<string, unknown>
}

type McpOk<T> = { ok: true } & T
type McpResult<T> = McpOk<T> | McpError
```

Encodings: `encoding` defaults to `utf8`. `base64` is required for binary payloads. Maximum body size: 10 MB at MCP layer (see §9 Q3).

| Tool | Parameters (TS) | Returns | Daemon endpoint(s) | Auto-commit? |
|---|---|---|---|---|
| `create_project` | `{ name: string; skill_id?: string; design_system_id?: string; pending_prompt?: string }` | `McpResult<{ project_id: string; conversation_id: string }>` | `POST /api/projects` (audit §1.1, `project-routes.ts:125`). MCP generates the project id (validated against `/^[A-Za-z0-9._-]{1,128}$/`); never sets `metadata.baseDir` (privileged to `/api/import/folder`, audit §1.6). | No (no files written on plain create; audit §2 "Project create" row) |
| `create_file` | `{ project_id: string; path: string; content: string; encoding?: 'utf8' \| 'base64' }` | `McpResult<{ file: ProjectFile }>` | `POST /api/projects/:id/files` (audit §1.5, `project-routes.ts:986`). Daemon endpoint is upsert; "create" vs "update" is an MCP-side affordance for caller intent only. | Yes |
| `update_file` | `{ project_id: string; path: string; content: string; encoding?: 'utf8' \| 'base64' }` | `McpResult<{ file: ProjectFile }>` | Same as `create_file`. | Yes |
| `rename_file` | `{ project_id: string; from: string; to: string }` | `McpResult<{ file: ProjectFile }>` | `POST /api/projects/:id/files/rename` (audit §1.5, `project-routes.ts:1070`). Also moves `<name>.artifact.json` sidecar (audit §3.4). | Yes |
| `soft_delete_file` | `{ project_id: string; path: string }` | `McpResult<{ trash_path: string }>` | `POST /api/projects/:id/files/rename` to `.trash/<ISO>-<basename>` (see §6). No daemon `DELETE` call. | Yes |
| `trigger_run` | `{ project_id: string; conversation_id: string; prompt: string; agent_id?: string; model?: string; skill_id?: string; design_system_id?: string; attachments?: Attachment[] }` | `McpResult<{ run_id: string }>` | `POST /api/runs` (audit §1.12, canonical inline at `server.ts:9561`). Sends `x-od-client: mcp` header. Returns immediately with daemon's 202 body. | No (see §3) |
| `cancel_run` | `{ run_id: string }` | `McpResult<{ ok: true }>` | `POST /api/runs/:id/cancel` (audit §5, `server.ts:9747`). | No |
| `list_runs` | `{ project_id: string; limit?: number }` | `McpResult<{ runs: RunSummary[] }>` | See §3 — endpoint TBD; if no list endpoint, v1 reads `runs` table via a daemon helper. | No |
| `list_skills` | `{}` | `McpResult<{ skills: SkillSummary[] }>` | Existing read endpoint (already in `mcp.ts` read tools surface; cite during implementation). | No |
| `list_design_systems` | `{}` | `McpResult<{ design_systems: DesignSystemSummary[] }>` | Existing read endpoint. | No |

### Tools explicitly NOT exposed in v1

| Excluded tool | Reason |
|---|---|
| `delete_project` | Audit §4 item 6 / §3.2: `removeProjectDir(...).catch(()=>{})` silently swallows FS errors and MCP can't intercept the delete. Refuse to expose until daemon surfaces FS-removal failures. |
| Conversation/message mutation (`PATCH /api/projects/:id/conversations/:cid`, `PUT .../messages/:mid`) | Too low-level. The message-PUT path has a non-obvious side effect — bumps `projects.updated_at` (audit §1.2, §2 "Message PUT"). |
| Live-artifact tools (`/api/tools/live-artifacts/*`, `/api/live-artifacts/:artifactId/*`) | Separate trust model — daemon endpoints expect a tool token whose `projectId`/`createdByRunId` are derived from the token (audit §1.8, §1.14). MCP has no equivalent issuance flow. |
| Plugin/skill/design-system install (`POST /api/skills/install`, `POST /api/design-systems/install`, plugin lifecycle) | Long-running git clones, executes arbitrary fetched code (audit §1.10–§1.11). Out of scope for v1. |
| Deploy tools (`PUT /api/deploy/config`, `POST /api/projects/:id/deploy`) | Exposes Vercel/CFPages credentials to agents; provider config secrets land on disk (audit §1.7). |
| Memory mutations (`PUT/PATCH/POST/DELETE /api/memory/*`) | Separate concern; deferred. |
| GenUI surfaces (`POST /api/runs/:runId/genui/:surfaceId/respond`, …) | Audit §6 Q8: unclear whether invocable without holding the run's SSE stream. Defer until that's clarified. |

---

## 2. Folder-import policy (locked)

**Rule:** if the project's `metadata.baseDir` is set, every write tool (`create_file`, `update_file`, `rename_file`, `soft_delete_file`) refuses with:

```ts
{
  ok: false,
  error_code: 'BASE_DIR_PROJECT_UNSUPPORTED',
  message: 'Project <id> was created via folder-import (metadata.baseDir is set). MCP write tools do not operate on folder-imported projects to avoid clobbering the user\'s own git state.',
  details: { project_id, base_dir }
}
```

**No silent skip. No commit attempted. No partial action.**

### Implementation shape

A single guard helper lives in `mcp/guards.ts`:

```ts
async function requireWritableProject(projectId: string): Promise<Project | McpError>
```

Called as the first step of every write tool. Returns either the `Project` row (with metadata) for happy path, or the typed `BASE_DIR_PROJECT_UNSUPPORTED` error. The guard fetches the project via `GET /api/projects/:id` once and the value is reused for the rest of the tool's work.

### Why refuse, not skip

Audit §4 item 1: folder-imported projects live at `metadata.baseDir`, which is the user's own folder. Two failure modes if we silently skip the commit:

1. The agent writes files but no commit shows up in the user's git log. Months later: "why didn't my changes show up in git?" with no audit trail.
2. The agent writes files into a folder that already has uncommitted user work, and the user's next `git status` is polluted with agent output indistinguishable from their own.

Refuse-with-typed-error is the only honest answer: the agent gets a clear signal it cannot write here, and the user's git state is untouched.

### `trigger_run` exception

`trigger_run` does not auto-commit (§3) so the folder-import guard does not apply to it. Files written *during* the run land in the user's folder and become part of the user's own git workflow — which is precisely the contract the user opted into by using folder-import. The agent's run can proceed normally; MCP just doesn't add a commit on top.

---

## 3. Run-trigger semantics (locked)

**Rule:** `trigger_run` wraps `POST /api/runs` (audit §5, canonical at `server.ts:9561`). Returns `{ run_id }` immediately, matching the daemon's `202 Accepted` shape (audit §5: "Asynchronous — the body returns immediately"). Does NOT block on completion. Does NOT auto-commit. Does NOT poll the run to completion.

### Headers

Every MCP-triggered run sends `x-od-client: mcp` on the request. Audit §5 notes the daemon currently uses this only for analytics (`clientType` label on PostHog `run_created` / `run_finished` events) and not for enforcement, but it's the right hook for future server-side budgets keyed off client type. MCP sets this unconditionally on `trigger_run` and `cancel_run`.

### Attribution and the commit log

Files written *during* a run go through `POST /api/projects/:id/files` from inside the agent's process (audit §5: "Tool use inside the run can write files"). Those writes do not pass through MCP, so MCP does not auto-commit them.

Acknowledged loose attribution: the files written during a run get folded into the next MCP write tool's commit. The git log will show that something changed (by timestamp + diff) but not which run produced it. This is acceptable for v1; the alternative (commit-from-watcher) is out of scope per audit §4 item 8.

### Cancellation

`cancel_run` wraps `POST /api/runs/:id/cancel` (audit §5, `server.ts:9747`). Errors:

- `RUN_NOT_FOUND` → daemon returned 404.
- `RUN_TERMINAL` → daemon returned 410 GONE (run already finalized; `runs.ts:168` semantics).
- `DAEMON_ERROR` → other non-2xx.

### `list_runs` endpoint resolution

Audit §1.12 and §5 do not document a dedicated `GET /api/runs?project_id=…` list endpoint. Three options for implementation in HRG-17:

1. Use `GET /api/projects/:id` if it returns recent runs in its payload (audit doesn't confirm — verify in implementation).
2. Add a small daemon helper that reads the `runs` table directly. Audit §2 "Routine run / `POST /api/runs`" notes the run itself is in-memory only (`createChatRunService` Map in `runs.ts:13`) — so a v1 `list_runs` may need to combine in-memory state with `routine_runs` history.
3. Drop `list_runs` from v1 if neither (1) nor (2) is cheap. The agent can track its own `run_id`s from `trigger_run` responses.

The locked decision is to include `list_runs` in the v1 surface; HRG-17 picks one of the three implementation paths.

---

## 4. Rate limits for `trigger_run` (locked)

**Defaults:** 3 concurrent runs per project, 10 runs per project per hour, 50 runs per project per day. Hard cap, not advisory. Overridable via `~/.od/mcp-write.json`.

### Why these numbers

Audit §5 calls `POST /api/runs` "potentially a multi-stage, multi-tool, unbounded-token operation. This is the single hardest thing to rate-limit responsibly — the daemon currently does nothing." The defaults assume manual-equivalent usage at the high end and exist primarily as a runaway-loop circuit breaker.

### Config file shape

Path: `~/.od/mcp-write.json` (alongside `app.sqlite`, under `RUNTIME_DATA_DIR`).

```json
{
  "trigger_run": {
    "max_concurrent_per_project": 3,
    "max_per_project_per_hour": 10,
    "max_per_project_per_day": 50
  }
}
```

Missing file → defaults above. Missing key inside file → that key defaults. Invalid value (non-number, negative) → log warning, fall back to default for that key only.

### Error envelope

```ts
{
  ok: false,
  error_code: 'RATE_LIMIT_EXCEEDED',
  message: 'trigger_run rate limit exceeded for project <id>',
  details: {
    project_id: string,
    dimension: 'concurrent' | 'hourly' | 'daily',
    current: number,
    limit: number,
    retry_after_seconds: number    // 0 for concurrent (any active run completing frees a slot)
  }
}
```

### State location

In-memory in the daemon process. A `Map<projectId, RateLimitWindow>` in `mcp/rate-limit.ts`. Accepted tradeoffs:

- State resets on daemon restart. Acceptable for v1 — daemon restarts are rare in interactive sessions, and the worst case (restart followed by burst) is bounded by the concurrent cap which is enforced from a fresh map.
- Process-local. There's only one daemon per `RUNTIME_DATA_DIR`, so this is correct by construction.
- No persistence to SQLite. Avoids designing a schema for what is essentially a circuit breaker; if persistence becomes necessary, that's an additive change.

---

## 5. Git auto-commit lifecycle

### When

After the daemon returns HTTP 2xx for the wrapped write, and before MCP returns the success result to the caller. On daemon failure (non-2xx, network error): no commit attempted, the error envelope is returned per §7.

### Where

Each `<projectDir>` is its own git repo. **Not** `<PROJECTS_DIR>` (i.e. `~/.od/projects/`) as a whole — per-project repos give clean isolation, matching the design intent that drove HRG-13.

`<projectDir>` is computed by `resolveProjectDir(PROJECTS_DIR, id, metadata)` (audit §0 "State roots"). For non-folder-imported projects this is `<PROJECTS_DIR>/<id>/`. Folder-imported projects are excluded by §2 so no commit happens there.

### First-write bootstrap

If `<projectDir>/.git/` does not exist when a write tool runs:

1. `git init` in `<projectDir>`.
2. Write `.gitignore` (contents below).
3. Initial empty commit: `git commit --allow-empty -m "mcp(bootstrap): initialize project repo"`.
4. Proceed with the actual write.
5. Commit the actual write.

Idempotent: subsequent writes see `.git/` exists and skip steps 1–3.

If the project was created via `create_project` but no file has been written yet, `<projectDir>` may not exist on disk (audit §2 "Project create": "`<projectDir>/` is created lazily by `ensureProject` only when a write actually happens"). The first write's daemon call creates the directory; bootstrap then runs against the now-existing directory.

### Commit message format

`mcp(<tool>): <path or short summary>`

Examples:

- `mcp(create_file): looks/field-edit.jsx`
- `mcp(update_file): app/layout.tsx`
- `mcp(rename_file): old.html -> archive/old.html`
- `mcp(soft_delete_file): old-dashboard.html`

### Author identity

Default: `mcp-write <mcp@open-design.local>`.

Override mechanism: `~/.od/mcp-write.json` extended with:

```json
{
  "git": {
    "author_name": "mcp-write",
    "author_email": "mcp@open-design.local"
  }
}
```

Applied per-commit via `git -c user.name=… -c user.email=… commit …` so it never mutates the repo's `.git/config` (keeps any user-set identity intact if the user later runs `git` manually in the same dir).

### `.gitignore` contents (written on first bootstrap)

```
# Live-artifact churn (audit §4 item 2)
.live-artifacts/*/refresh.lock.json
.live-artifacts/*/refresh-state.json
.live-artifacts/*/refreshes.jsonl
.live-artifacts/*/snapshots/

# Binary blobs (audit §4 item 3)
*.mp4
*.webm
*.wav
*.mp3

# Soft-delete trash (see §6)
.trash/
```

If the user has already created a `.gitignore` (e.g. they ran `git init` themselves before MCP touched the project), bootstrap detects the existing file and appends only the rules above that are not already present, preserving the user's content. If `.gitignore` already contains all the rules, no change.

### Failure modes

- `git commit` returns "nothing to commit" (the write was a no-op overwrite with identical bytes): log a warning, return success to the caller. The daemon write succeeded — commit is a safety net, not a correctness gate.
- `git commit` fails for any other reason (corrupt repo, permission denied, …): log the error, return success to the caller with a warning in the response payload. The daemon write succeeded; the commit failure should not undo the user-visible outcome.
- `git` binary not installed: at bootstrap time, log a single warning per project per daemon process and disable auto-commit for that project. Writes succeed without commits. (We do not refuse writes — git is a safety net, not a hard dependency.)

### Concurrent-write race

Two simultaneous MCP write tools on the same project can interleave their `git add` / `git commit`. Accepted: last-writer-wins ordering, no project-level lock in v1. Audit §3.3 already documents that `writeProjectFile` itself is not atomic ("direct overwrite, no tmp + rename") and concurrent writes race at the kernel level — adding a commit-side lock would not fix the underlying race, only displace it.

If the same file is written by two concurrent calls, the resulting commit history shows two commits with potentially identical or out-of-order content. Acceptable for v1.

---

## 6. Soft-delete mechanics

**Tool:** `soft_delete_file(project_id, path)`

### Steps

1. Resolve target trash path: `<projectDir>/.trash/<ISO-timestamp>-<basename>` where `<ISO-timestamp>` is `new Date().toISOString()` with `:` replaced by `-` for filesystem safety.
2. Call `POST /api/projects/:id/files/rename` with `{ from: path, to: <trash-path> }` (audit §1.5, `project-routes.ts:1070`). The daemon handles `mkdir -p .trash/` implicitly because the rename target's parent is created via `mkdir -p dirname(target)` in `renameProjectFile` step 5 (audit §3.4).
3. On daemon success: auto-commit per §5 with message `mcp(soft_delete_file): <original path>`. The `.trash/` content is `.gitignore`d so the commit shows only the deletion of the original path.
4. Return `{ ok: true, trash_path }`.

### No daemon `DELETE`

The file is never `unlink`ed — it's just hidden under `.trash/`. Audit §3.5 notes that `deleteProjectFile` leaves the `.artifact.json` sidecar orphaned; the rename path (audit §3.4) keeps the sidecar with the content. Soft-delete via rename therefore preserves the artifact pairing.

### Trash management

- Trash dir is created lazily on first soft-delete by the daemon's `mkdir -p` (step 2 above).
- Trash is `.gitignore`d (§5) so trashed files never enter the commit history.
- No auto-empty in v1. Manual cleanup: `rm -rf <projectDir>/.trash/` by the user.
- No restore tool in v1. Manual restore: `mv <projectDir>/.trash/<file> <projectDir>/<original-path>` by the user.

### Why timestamp prefix

If the same path is soft-deleted twice (e.g. created, deleted, recreated, deleted again), the second rename would collide with the first under bare-basename naming. The daemon's rename rejects with 409 EEXIST in that case (audit §1.5). Timestamp prefix sidesteps the collision entirely.

---

## 7. State-after-failure recovery

For every write tool, on daemon 5xx or network error, MCP does NOT auto-commit and returns a structured envelope describing observed reality.

### Why this matters

Audit §3.8: "No mutation in the daemon wraps both an SQLite write and a filesystem write in a single transaction." A 5xx response can mean any of:

- Nothing happened.
- Everything happened but the response was lost in flight.
- Half happened (SQLite committed, filesystem write failed; or filesystem write succeeded, sidecar write failed — audit §3.3).

MCP cannot fix this. It can surface it honestly.

### Recovery probe

After a non-2xx response from a write tool:

1. Capture `daemon_status` (HTTP code or `network_error`).
2. Probe the post-state with read-only daemon calls:
   - For project-level tools: `GET /api/projects/:id`.
   - For file-level tools: `GET /api/projects/:id/files/<path>` if such an endpoint exists; otherwise list-files and search. Audit §1.5 does not document a per-file GET — verify during implementation; if absent, the probe falls back to "list project files and check membership".
3. Build `recovered_state` describing what the probe saw:
   - `{ project_exists: boolean, file_exists: boolean, content_matches?: boolean }` for file tools.
   - `{ project_exists: boolean, conversation_exists: boolean }` for `create_project`.

### Envelope

```ts
{
  ok: false,
  error_code: 'DAEMON_ERROR',
  message: string,
  daemon_status: number,           // or absent for network errors
  recovered_state?: {
    project_exists?: boolean,
    file_exists?: boolean,
    content_matches?: boolean,     // sha256 compare vs intended content
    sidecar_exists?: boolean,      // for artifact-bearing writes
  },
  details?: { intended_path?: string, probe_error?: string }
}
```

If the recovery probe itself fails, `recovered_state` is omitted and `details.probe_error` carries the reason.

### Open gap

Audit §1.5 does not confirm a per-file GET endpoint. If implementation discovers none and adding one is out of scope for HRG-15+, the file-existence check falls back to a project file listing, and `content_matches` is omitted (we don't want to fetch full file contents just to hash them). This is a fidelity loss MCP accepts; the caller still gets `daemon_status` + `file_exists` which is enough to decide retry vs abort.

---

## 8. Module layout

Refactor `apps/daemon/src/mcp.ts` (currently 7 read-only tools) into a directory:

```
apps/daemon/src/mcp/
├── index.ts          # MCP server setup, tool registration
├── read-tools.ts     # existing 7 tools moved here verbatim
├── write-tools.ts    # create_file, update_file, rename_file, soft_delete_file, create_project
├── run-tools.ts      # trigger_run, cancel_run, list_runs
├── catalog-tools.ts  # list_skills, list_design_systems
├── commit.ts         # git auto-commit helper (used by write-tools.ts)
├── rate-limit.ts     # trigger_run rate limiter
├── trash.ts          # soft-delete helper (path computation + rename orchestration)
├── errors.ts         # typed error envelope builders
└── guards.ts         # requireWritableProject (baseDir check + existence)
```

`apps/daemon/src/mcp.ts` becomes a one-line re-export from `./mcp/index.ts` for backward compatibility with any caller that imports the old path.

### Notes

- This refactor is part of v1 implementation (HRG-15), not a separate cleanup task.
- The read-tools move is purely cosmetic — no behavior change. HRG-15's scope is the move + the one-line re-export, with no new tools yet. HRG-16 lands write tools. HRG-17 lands run tools.
- Each tool group is independently testable: `guards.ts` and `errors.ts` have no I/O; `commit.ts` is tested against a real temp git repo; `rate-limit.ts` is pure timer logic; `trash.ts` is path computation plus a single mocked daemon call.
- `catalog-tools.ts` exists to keep the v1 surface obviously partitioned even though it contains only two read-only tools; future catalog tools land here without forcing a re-split.

---

## 9. Open questions deferred to implementation

Anchored to HRG-13 §6:

| Audit Q | Question | v1 disposition |
|---|---|---|
| Q1 | Plugin filesystem layout under `RUNTIME_DATA_DIR` | Not needed for v1 — plugin tools not exposed (§1 exclusions). Revisit if/when plugin install enters MCP surface. |
| Q2 | `media-tasks.ts` output path | Not needed for v1 — media tools not exposed. |
| Q3 | Multer global size limits | Affects `create_file` / `update_file` with large bodies. v1 enforces a 10 MB hard cap at the MCP layer (`FILE_TOO_LARGE`) before sending to daemon. Implementation reads the multer global cap during HRG-16; if it's tighter than 10 MB, MCP cap matches it; if looser or absent, MCP keeps 10 MB. |
| Q4 | Live-artifact write atomicity | `.live-artifacts/` is `.gitignore`d (§5) so its atomicity does not affect our commits. Not our concern for v1. |
| Q5 | `project-watchers.ts` mutation behavior | Accept that any watcher-driven writes fold into the next MCP commit (§3 attribution note). |
| Q6 | Tool-token minting | Not needed for v1 — no MCP tool calls token-protected endpoints. |
| Q7 | ACP write paths in `runtimes/` / `pi-rpc.ts` | Not exposed in v1. Treat HTTP surface as canonical write surface (per audit §6 Q7's recommendation). |
| Q8 | GenUI surfaces | Not exposed in v1. |
| Q9 | Routine scheduler triggering writes | Accept that scheduler-driven writes fold into the next MCP commit (§3 attribution note). |
| Q10 | Route duplication intent (`server.ts` vs `chat-routes.ts`) | Irrelevant for MCP layer; the audit already pinned canonical handlers (§0 Surprise). HRG-15+ relies on those canonical citations and does not need to resolve the duplication. |

---

## Decisions to revisit (appendix)

Honest call-outs where a locked decision could bite us, with the bar for revisiting:

1. **Per-project git repos vs single `~/.od/projects/` repo.** Per-project is clean isolation but means N `.git/` dirs and N first-write bootstraps. If users routinely work across 50+ projects, the cost is real. Revisit if telemetry shows >20 projects per user as a common case.

2. **In-memory rate-limit state.** Resets on daemon restart. A user who hits the daily cap, restarts the daemon, and immediately hits it again loses the cap. Acceptable for v1; revisit if abuse is observed.

3. **Loose run-write attribution.** Files written during a `trigger_run` show up in the next MCP commit, not a per-run commit. Acceptable because building per-run commits requires holding the SSE stream and committing on `run_finished`, which couples MCP to the daemon's run lifecycle. Revisit if users complain that the git log doesn't tell them which run produced which file.

4. **`list_runs` implementation uncertainty.** §3 lists three implementation paths, none verified. If HRG-17 finds none of the three are cheap, we drop `list_runs` from v1 and the agent tracks `run_id`s itself. This is the most likely tool to slip the v1 surface.

5. **State-recovery probe fidelity.** Audit doesn't confirm a per-file GET endpoint. If none exists and listing is the only fallback, `content_matches` is omitted from `recovered_state`. Revisit if callers need definitive write-confirmation post-5xx.

6. **`soft_delete_file` has no restore tool.** Users restore by `mv` from `.trash/`. If MCP-using agents commonly need to undo their own deletions mid-conversation, a `restore_file` tool becomes worth adding. v1 ships without it.

7. **No project-level lock for concurrent MCP writes.** Two writes to the same path race at the daemon, commit at the MCP layer in whichever order they finish. Audit §3.3 already documents the kernel-level race; the MCP-side commit race is downstream of that. If concurrent-write contention becomes observable, the fix is a lock at the daemon `writeProjectFile` layer, not at MCP.
