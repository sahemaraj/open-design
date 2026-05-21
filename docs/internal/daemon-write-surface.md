# Daemon write surface audit (mcp-write planning)

Scope: every mutating HTTP surface in `apps/daemon/src/` that is reachable from the local UI / CLI, mapped to its on-disk and SQLite footprint. This is the input for designing the writable `od mcp` tool surface; it is not itself an implementation plan.

Branch: `feature/mcp-write` off `upstream/main`. No code changed by this audit.

---

## 0. Orientation

### State roots

All persistent state lives under `RUNTIME_DATA_DIR` (`apps/daemon/src/server.ts:1161`), defaulting to `<projectRoot>/.od` and overridable via `OD_DATA_DIR`. Inside it:

- `app.sqlite` — single SQLite database opened by `apps/daemon/src/db.ts:30`, WAL mode, foreign keys on. Tables: `projects`, `templates`, `conversations`, `messages`, `preview_comments`, `tabs`, `deployments`, `routines`, `routine_runs`, plus what `migrateCritique`, `migrateMediaTasks`, `migratePlugins` add (`apps/daemon/src/db.ts:52-264`).
- `projects/<id>/` — per-project content tree. Path is computed by `resolveProjectDir` (`apps/daemon/src/projects.ts:41`); when `project.metadata.baseDir` is set the project's files live *outside* `.od/` at the user's chosen folder (folder-import case). Both branches go through the same `writeProjectFile`/`deleteProjectFile`/`renameProjectFile` API in `projects.ts`.
- `projects/<id>/.live-artifacts/<artifactId>/` — live-artifact bundles (`apps/daemon/src/live-artifacts/store.ts:16-25`): `artifact.json`, `template.html`, `index.html`, `data.json`, `provenance.json`, `refreshes.jsonl`, `refresh.lock.json`, `refresh-state.json`, `snapshots/`.
- `projects/<id>/<name>.artifact.json` — sidecar manifest written alongside any project file that carries `artifactManifest` (see `writeProjectFile` in `projects.ts:680-684`).
- `skills/`, `design-systems/`, `design-templates/` — user-installed catalog dirs (`server.ts:1191-1197`). First-party catalogs live next to the bundle (`SKILLS_DIR`, `DESIGN_SYSTEMS_DIR` at `server.ts:993-998`); user installs go to the `USER_*` siblings under the data dir.
- `artifacts/` — `ARTIFACTS_DIR` (`server.ts:1185`), target for `/api/artifacts/save`.
- `critique-artifacts/`, `od-plugin-lock.json`, media tasks, plugin payloads — additional dirs/files alongside `app.sqlite`.

### Route module map (mounted in `server.ts:3706-9946`)

`registerProjectRoutes` (3706), `registerImportRoutes` (3720), `registerProjectArtifactRoutes` (3746), `registerLiveArtifactRoutes` (3753), `registerDeployRoutes` (3762), `registerProjectFileRoutes` (3789), `registerMediaRoutes` (3801), `registerChatRoutes` (9946). Also `registerStaticResourceRoutes` (skills + design systems), `registerRoutineRoutes`, `registerConnectorsRoutes`, `registerMcpRoutes`, `registerProjectExportRoutes`, `registerDeploymentCheckRoutes`.

### Surprise (called out up front)

`server.ts` is ~10 000 lines and still carries **inline duplicates of most route handlers** — e.g. `app.delete('/api/projects/:id', …)` at `server.ts:3816` and again as the canonical implementation in `project-routes.ts:390`, the same for `/api/projects/:id/conversations`, `/api/projects/:id/tabs`, `/api/templates`, `/api/tools/live-artifacts/*`, `/api/deploy/*`, `/api/projects/:id/raw/*`, `/api/projects/:id/files/:name`, `/api/projects/:id/media/generate`, `/api/research/search`, `/api/media/tasks/:id/wait`, `/api/orbit/run`, `/api/dialog/open-folder`, `/api/media/config`, `/api/app-config`, etc.

Because Express dispatches the **first** registered handler for a path+method, and the `register*` calls run at lines 3706-3801 *before* the inline duplicates at 3816+, every inline copy in that range is effectively dead code shadowed by its module sibling. The opposite direction holds for `/api/runs` and `/api/chat`: the inline definitions at `server.ts:9561` and `9756` run *before* `registerChatRoutes` at 9946, so those are the canonical handlers and `chat-routes.ts`'s `/api/runs` and `/api/chat` are shadowed instead.

Implication for mcp-write: when modelling write semantics, read the dedicated route module for everything in the 3700-7600 range, and the inline `server.ts` block for `/api/runs`, `/api/runs/:id/cancel`, `/api/chat`. Don't trust `chat-routes.ts` as the source of truth for the run-trigger contract.

---

## 1. HTTP write endpoints

The hunt was `grep -rn "\.(post|put|patch|delete)\(" apps/daemon/src/`. Each row below points at the **canonical** handler after the shadowing rule above. Middleware, OAuth, plugin lifecycle, marketplace admin, and telemetry endpoints are listed but not deeply unpacked.

Where the request/response body shape is enforced by a TypeScript type in `@open-design/contracts` (most write endpoints), I cite the route's `/** @type … */` annotation rather than re-deriving it from the handler.

### 1.1 Projects (canonical: `project-routes.ts`)

| Method + path | Source | Body in | Body out | Failure modes | UI use |
|---|---|---|---|---|---|
| `POST /api/projects` | `project-routes.ts:125` | `{ id, name, skillId?, designSystemId?, pendingPrompt?, metadata?, customInstructions?, skipDiscoveryBrief?, pluginId?, appliedPluginSnapshotId? }`. `id` matches `/^[A-Za-z0-9._-]{1,128}$/`; `metadata.baseDir` and `metadata.fromTrustedPicker` are rejected here (only `/api/import/folder` may set them); `customInstructions` ≤5000 chars. | `CreateProjectResponse` = `{ project, conversationId, appliedPluginSnapshotId? }` | 400 on invalid id/name/baseDir attempt/customInstructions size; resolver may surface a plugin error (status from `resolved.status`) when an explicit plugin is requested. | `apps/web/src/state/projects.ts:75` |
| `PATCH /api/projects/:id` | `project-routes.ts:308` | `{ name?, skillId?, designSystemId?, pendingPrompt?, metadata?, customInstructions? }`. `metadata.baseDir` immutable after import; partial-metadata patches preserve baseDir/fromTrustedPicker/importedFrom from the existing row. `linkedDirs` re-validated via `validateLinkedDirs`. | `ProjectResponse` = `{ project }` | 400 BAD_REQUEST, 400 INVALID_LINKED_DIR, 404 PROJECT_NOT_FOUND. | UI project rename / settings panel. |
| `DELETE /api/projects/:id` | `project-routes.ts:390` (shadowing inline `server.ts:3816`) | none | `OkResponse` = `{ ok: true }` | 400 BAD_REQUEST on db error. Filesystem removal swallowed (`removeProjectDir(...).catch(() => {})`). | UI "Delete project". |
| `GET /api/projects/:id/events` | `project-routes.ts:409` | SSE | n/a | SSE | UI live preview. Read-only, listed only because it's intertwined with the SSE invalidations that every mutation expects to fire. |

### 1.2 Conversations + messages (canonical: `project-routes.ts`)

| Method + path | Source | Body in | Body out | Failure | UI |
|---|---|---|---|---|---|
| `POST /api/projects/:id/conversations` | `project-routes.ts:457` | `{ title? }` | `{ conversation }` | 404 project missing. | yes |
| `PATCH /api/projects/:id/conversations/:cid` | `project-routes.ts:473` | `{ title?, … }` (whatever `updateConversation` accepts) | `{ conversation }` | 404. | yes |
| `DELETE /api/projects/:id/conversations/:cid` | `project-routes.ts:482` | none | `{ ok: true }` | 404. | yes |
| `PUT /api/projects/:id/conversations/:cid/messages/:mid` | `project-routes.ts:501` | message body (role, content, events, attachments, …) | `{ message }` | 400 id mismatch, 404. Side effect: `updateProject(db, projectId, {})` bumps `projects.updated_at`; `telemetry.reportFinalizedMessage` fires. | yes |

### 1.3 Preview comments (canonical: `project-routes.ts`)

| Method + path | Source | Body in | Body out | Failure |
|---|---|---|---|---|
| `POST /api/projects/:id/conversations/:cid/comments` | `project-routes.ts:532` | comment payload (selector, label, text, position, html_hint, note, status, selection_kind, member_count, pod_members). UNIQUE by `(project_id, conversation_id, file_path, element_id)`. | `{ comment }` | 400, 404. |
| `PATCH /api/projects/:id/conversations/:cid/comments/:commentId` | `project-routes.ts:551` | `{ status }` | `{ comment }` | 400, 404. |
| `DELETE /api/projects/:id/conversations/:cid/comments/:commentId` | `project-routes.ts:576` | none | `{ ok: true }` | 404. |

### 1.4 Tabs + templates (canonical: `project-routes.ts`)

| Method + path | Source | Body in | Body out |
|---|---|---|---|
| `PUT /api/projects/:id/tabs` | `project-routes.ts:604` | `{ tabs: string[], active?: string \| null }` | result of `setTabs` |
| `POST /api/templates` | `project-routes.ts:638` | `{ name, description?, sourceProjectId }` (name ≤100 chars). Snapshots every `html`/`text`/`code` file of source project at request time. Upsert by `(name, sourceProjectId)`. | `{ template }` |
| `DELETE /api/templates/:id` | `project-routes.ts:702` | none | `{ ok: true }` |

### 1.5 Project files (canonical: `project-routes.ts`)

| Method + path | Source | Body in | Body out | Notes |
|---|---|---|---|---|
| `POST /api/projects/:id/files` | `project-routes.ts:986` | Either multipart `file` (multer) OR `{ name, content, encoding?: 'base64', artifactManifest? }`. | `ProjectFileResponse` = `{ file }` (with stub-guard warning when applicable) | 422 ARTIFACT_REGRESSION when stub-guard rejects; 400 on bad manifest; 500 on internal. Drives most agent writes. |
| `POST /api/projects/:id/files/rename` | `project-routes.ts:1070` | `{ from, to }` | `RenameProjectFileResponse` | 404 ENOENT, 409 EEXIST, 400. Also moves the `<name>.artifact.json` sidecar (`commitArtifactManifestRename`). |
| `DELETE /api/projects/:id/files/:name` | `project-routes.ts:1099` | none | `{ ok: true }` | 404 / 400. |
| `DELETE /api/projects/:id/raw/*` | `project-routes.ts:917` | none | `{ ok: true }` | Same `deleteProjectFile` as above; the `/raw/*` variant is for nested paths. |
| `POST /api/upload` | `project-routes.ts:716` | multer `images[]` (≤8) | `{ files }` | Drops into multer staging; *not* a project write — callers must follow up with `/api/projects/:id/files`. |
| `POST /api/projects/:id/upload` | `project-routes.ts:1126` | multer multi-file | `UploadProjectFilesResponse` | Files land directly inside the project tree via `handleProjectUpload`. |
| `POST /api/artifacts/save` | `project-routes.ts:730` | `{ identifier?, title?, html }` | `{ path, url, lint }` | Writes a freestanding HTML file under `ARTIFACTS_DIR/<stamp>-<slug>/index.html`. Not a project file. |
| `POST /api/artifacts/lint` | `project-routes.ts:756` | `{ html }` | `{ findings, agentMessage }` | Pure function — listed only because of the POST verb. |

### 1.6 Imports + exports (`import-export-routes.ts`)

| Method + path | Source | Body in | Body out | Notes |
|---|---|---|---|---|
| `POST /api/import/claude-design` | `import-export-routes.ts:30` | multipart `file=<zip>` | `{ project, conversationId, entryFile, files }` | Unzips into `<PROJECTS_DIR>/<id>/`, seeds a conversation, sets tabs. |
| `POST /api/import/folder` | `import-export-routes.ts:95` | `{ baseDir, name?, skillId?, designSystemId? }` + optional `x-od-desktop-import-token` header. | `ImportFolderResponse` = `{ project, conversationId, entryFile }` | Privileged: this is the *only* path that may set `metadata.baseDir`/`fromTrustedPicker`. Hardened against symlink escape via `realpath` + `RUNTIME_DATA_DIR_CANONICAL` reentry check. |
| `POST /api/projects/:id/archive/batch` | `import-export-routes.ts:285` | `{ files: string[] }` | ZIP bytes | Read-only on disk; lists files. |
| `POST /api/projects/:id/export/pdf` | `import-export-routes.ts:321` | per-file PDF input | PDF bytes | Spawns the desktop PDF exporter. No project mutation. |
| `POST /api/projects/:id/finalize/anthropic` | `import-export-routes.ts:538` | finalize-design body | streamed | Generates HTML and (via the finalize pipeline) lands rendered output back into the project. |

### 1.7 Deploy (`deploy-routes.ts`)

| Method + path | Source | Body in | Body out | Notes |
|---|---|---|---|---|
| `PUT /api/deploy/config` | `deploy-routes.ts:30` | provider config | `DeployConfigResponse` | Writes provider config file (Vercel / Cloudflare Pages) under the data dir; secrets land on disk. |
| `POST /api/projects/:id/deploy` | `deploy-routes.ts:71` | `{ fileName, providerId?, cloudflarePages? }` | `DeployProjectFileResponse` | Upserts a row in `deployments`; calls Vercel/CFPages provider. Failure modes captured by `DeployError`. |
| `POST /api/projects/:id/deploy/preflight` | `deploy-routes.ts:154` | `{ fileName, providerId? }` | `DeployPreflightResponse` | Read-only validation. |
| `POST /api/projects/:id/deployments/:deploymentId/check-link` | `deploy-routes.ts:204` | none | `CheckDeploymentLinkResponse` | Pings live URL; upserts deployment row with reachability. |

### 1.8 Live artifacts (`live-artifact-routes.ts`)

All write paths go through `apps/daemon/src/live-artifacts/store.ts` which manages `<projectDir>/.live-artifacts/<artifactId>/`.

| Method + path | Source | Auth | Notes |
|---|---|---|---|
| `POST /api/tools/live-artifacts/create` | `live-artifact-routes.ts:104` | tool token (scope `live-artifacts:create`) | `projectId`/`createdByRunId` derived from token; supplied values rejected if they disagree. |
| `POST /api/tools/live-artifacts/update` | `live-artifact-routes.ts:156` | tool token | Same. |
| `POST /api/tools/live-artifacts/refresh` | `live-artifact-routes.ts:185` | tool token | Emits `started`/`succeeded`/`failed` events. |
| `PATCH /api/live-artifacts/:artifactId` | `live-artifact-routes.ts:230` | open | UI-side update. |
| `DELETE /api/live-artifacts/:artifactId` | `live-artifact-routes.ts:250` | open | Reads first to surface a `deleted` event payload, then `deleteLiveArtifact`, then bumps project `updated_at`. |
| `POST /api/live-artifacts/:artifactId/refresh` | `live-artifact-routes.ts:279` | `requireLocalDaemonRequest` | UI-triggered refresh. |

### 1.9 Routines (`routine-routes.ts`)

| Method + path | Source | Body in | Notes |
|---|---|---|---|
| `POST /api/routines` | `routine-routes.ts:131` | `{ name, prompt, schedule, target, skillId?, agentId?, enabled? }` (schema validated by `validateSchedule`/`validateTarget`). | Inserts to `routines`, reschedules. |
| `PATCH /api/routines/:id` | `routine-routes.ts:165` | partial of above | Reschedules on every save. |
| `DELETE /api/routines/:id` | `routine-routes.ts:190` | none | Unschedules + deletes. |
| `POST /api/routines/:id/run` | `routine-routes.ts:197` | none | **Run trigger #2.** Synchronously calls `routineService.runNow`, which creates a project (or reuses one), a conversation, and an agent run; returns `{ projectId, conversationId, agentRunId }`. Inserts a `routine_runs` row. |

### 1.10 Skills, design systems, prompt templates (`static-resource-routes.ts`)

| Method + path | Source | Body in | Notes |
|---|---|---|---|
| `POST /api/skills/import` | `static-resource-routes.ts:123` | `{ name, body, … }` | Writes `SKILL.md` under `USER_SKILLS_DIR/<id>/`. |
| `PUT /api/skills/:id` | `static-resource-routes.ts:157` | partial skill body | Updates user-managed skill; clones built-in side files on first user edit. |
| `POST /api/skills/install` | `static-resource-routes.ts:554` | `{ target: <git url \| folder> }` | `requireLocalOrigin`. Materializes a skill under `USER_SKILLS_DIR/`. Long-running git clone. |
| `DELETE /api/skills/:id` | `static-resource-routes.ts:581` | none | Removes the skill dir (only from `USER_SKILLS_DIR`; built-ins refuse). |
| `POST /api/design-systems/install` | `static-resource-routes.ts:592` | `{ target }` | Mirrors skill install under `USER_DESIGN_SYSTEMS_DIR/`. |
| `DELETE /api/design-systems/:id` | `static-resource-routes.ts:612` | none | Mirrors skill delete. |
| `POST /api/codex-pets/sync` | `static-resource-routes.ts:233` | `{ source?, force? }` | Downloads pet packs from external catalogs into `${CODEX_HOME:-~/.codex}/pets/` — outside `RUNTIME_DATA_DIR`. |

### 1.11 MCP, connectors, OAuth, plugins, marketplaces, memory

- `mcp-routes.ts`: `PUT /api/mcp/servers` (server config), `POST /api/mcp/oauth/start`, `POST /api/mcp/oauth/disconnect`.
- `connectors/routes.ts`: `PUT /api/connectors/composio/config`, `POST /api/connectors/auth-configs/prepare`, `POST /api/connectors/:connectorId/connect`, `POST /api/connectors/:connectorId/authorization/cancel`, `DELETE /api/connectors/:connectorId/connection`, `POST /api/tools/connectors/execute`. Most carry `requireLocalDaemonRequest`.
- `server.ts:4365-5563`: plugin lifecycle endpoints — `POST /api/plugins/upload-zip|upload-folder|install|:id/uninstall|:id/upgrade|:id/apply|:id/share-project|:id/doctor|:id/trust`, `POST /api/marketplaces`, `DELETE /api/marketplaces/:id`, `POST /api/marketplaces/:id/refresh`, `POST /api/marketplaces/:id/trust`, `POST /api/applied-plugins/export|prune`. These mutate the plugin SQLite tables and the on-disk plugin staging area.
- `server.ts:3134-3411`: memory — `PUT /api/memory/index`, `PATCH /api/memory/config`, `POST /api/memory/extract`, `POST /api/memory`, `PUT /api/memory/:id`, `DELETE /api/memory/:id`, `DELETE /api/memory/extractions[/<id>]`.
- `server.ts:2945-3031`: daemon admin — `POST /api/plugins/events/purge`, `POST /api/daemon/db/verify`, `POST /api/daemon/db/vacuum`, `POST /api/daemon/shutdown`. All gated by `requireLocalDaemonRequest`.
- `server.ts:5610-5759`: GenUI write surfaces — `POST /api/runs/:runId/genui/:surfaceId/respond`, `POST /api/projects/:projectId/genui/:surfaceId/revoke`, `POST /api/projects/:projectId/genui/prefill`, `POST /api/runs/:runId/replay`.

### 1.12 Runs + chat (canonical: inline `server.ts`)

| Method + path | Source | Body in | Body out | Notes |
|---|---|---|---|---|
| `POST /api/runs` | `server.ts:9561` (`chat-routes.ts:70` is shadowed) | `{ projectId, conversationId, assistantMessageId, clientRequestId, agentId, model, message, currentPrompt, attachments[], skillId, designSystemId, pluginId?, appliedPluginSnapshotId?, … }` | `202 { runId, appliedPluginSnapshotId?, pluginId? }` | **Run trigger #1.** Detail in §5. |
| `POST /api/runs/:id/cancel` | `server.ts:9747` | none | `{ ok: true }` | Detail in §5. |
| `POST /api/runs/:id/tool-result` | `chat-routes.ts:247` | `{ toolUseId, content, isError? }` | `{ ok: true }` | Feeds a `tool_result` into the still-running stream-json child. 400/404/410 envelopes. |
| `POST /api/chat` | `server.ts:9756` | same shape as `/api/runs` | SSE | Legacy single-shot chat. |
| `POST /api/provider/models` | `chat-routes.ts:297` | provider config | `{ ok, models? }` | Read-only on disk (config + remote fetch). |
| `POST /api/test/connection` | `chat-routes.ts:356` | provider config | `{ ok, … }` | Same. |
| `POST /api/proxy/anthropic|openai|azure|google|ollama/stream` | `chat-routes.ts:695-1100` | provider-specific | streamed | Stateless passthrough proxies; no daemon-side persistence. Out of scope for MCP write. |

### 1.13 Misc local-only

`POST /api/orbit/run`, `POST /api/dialog/open-folder`, `POST /api/research/search`, `POST /api/media/tasks/:id/wait`, `POST /api/projects/:id/media/generate`, `PUT /api/media/config`, `PUT /api/app-config` — all guarded by `isLocalSameOrigin` and live in `media-routes.ts`.

### 1.14 Auth pattern summary

- `requireLocalDaemonRequest` — DB vacuum, daemon shutdown, plugin event purge, live-artifact refresh (UI variant), MCP OAuth, connectors admin.
- `requireLocalOrigin` — skills/design-systems install/uninstall.
- `isLocalSameOrigin` — every media route.
- `authorizeToolRequest` — tool-token endpoints (`/api/tools/live-artifacts/*`, `/api/tools/connectors/execute`). `projectId` / `runId` derived from the token, supplied values rejected when they disagree.
- `verifyDesktopImportToken` — `/api/import/folder` when the desktop auth gate is active (HMAC-signed nonce header).
- Everything else: no auth. Couldn't determine from source whether the Electron preload layer adds anything on top — the daemon trusts whoever can reach the loopback port.

---

## 2. State storage map

What gets written per mutation kind, expressed as `<SQLite tables>` + `<filesystem under RUNTIME_DATA_DIR>`. "Project root" = `resolveProjectDir(PROJECTS_DIR, id, metadata)` (either `<PROJECTS_DIR>/<id>/` or `metadata.baseDir`).

| Mutation kind | SQLite | Filesystem |
|---|---|---|
| Project create (`POST /api/projects`) | `projects` (insert), `conversations` (one seed row); `applied_plugin_snapshots` row when a plugin is resolved. Template-seeded creates also write template files to disk via `writeProjectFile`. | `<projectDir>/` is created lazily by `ensureProject` only when a write actually happens; the plain create path doesn't `mkdir` if there's no template. Template-seeded create writes one file per template entry into `<projectDir>/`. |
| Project import folder (`POST /api/import/folder`) | `projects` (insert; metadata.baseDir set), `conversations` (insert), `tabs` (`setTabs`). | Nothing new on disk — the user's existing folder is adopted as the project root. |
| Project import zip (`POST /api/import/claude-design`) | Same as above plus `tabs`. | Zip unpacked into `<PROJECTS_DIR>/<id>/` then `unlink` the staging upload. |
| Project patch (`PATCH /api/projects/:id`) | `projects.updated_at`, metadata, custom_instructions, linked-dirs. | none |
| Project delete (`DELETE /api/projects/:id`) | `projects` row (CASCADE drops `conversations`, `messages`, `preview_comments`, `tabs`, `deployments`). | `rm -rf <PROJECTS_DIR>/<id>/` *(no-op when `metadata.baseDir` points outside — see §3)*. |
| Project file write (`POST /api/projects/:id/files`) | none directly (project updatedAt not bumped here — only the message-PUT path bumps it). | `<projectDir>/<name>`; optional `<name>.artifact.json` sidecar; stub-guard side scan reads `dirname(target)`. |
| Project file rename | none | `<projectDir>/<from>` → `<to>`; if a `<from>.artifact.json` sidecar exists it's rewritten with the new identifier, then renamed. |
| Project file delete | none | `unlink <projectDir>/<name>`. |
| Conversation create / update / delete | `conversations` (+ CASCADE on delete to `messages` / `preview_comments`). | none |
| Message PUT | `messages` (upsert) + `projects.updated_at` bump. | none |
| Preview comment write | `preview_comments` (upsert / status / delete) + `projects.updated_at` bump. | none |
| Tabs PUT | `tabs` (replace-set semantics via `setTabs`). | none |
| Template POST | `templates` (insert/update). | Reads project files; no writes. |
| Template DELETE | `templates` row. | none |
| Live-artifact create / update / delete / refresh | none (live-artifact data is filesystem-only; project `updated_at` is bumped only on delete). | `<projectDir>/.live-artifacts/<artifactId>/{artifact.json,template.html,index.html,data.json,provenance.json,refreshes.jsonl,refresh.lock.json,refresh-state.json,snapshots/…}` |
| Deploy | `deployments` upsert (UNIQUE on `(project_id, file_name, provider_id)`). | Provider config file (Vercel/CFPages) under data dir; deployed artifacts go to provider, not daemon disk. |
| Routine create / patch / delete | `routines` (+ CASCADE on delete to `routine_runs`). | none |
| Routine run / `POST /api/runs` | Possibly `projects` (`reuse` mode reuses, `create_each_run` inserts via the routine service); `conversations` (insert); `routine_runs` (insert); `applied_plugin_snapshots` row when a plugin resolves; for chat runs nothing in SQLite until the assistant message lands. The run itself is in-memory only (`createChatRunService` Map in `runs.ts:13`). | none directly. Anything the agent writes during the run goes through `writeProjectFile`, `live-artifacts/store.ts`, or `/api/artifacts/save`. |
| Media generate | `media_tasks` (`persistMediaTask` in `media-tasks.ts`). | Media outputs land via the task on completion; couldn't determine the exact target dir without reading `media.ts`. |
| Skill install / uninstall | none in SQLite (catalogs are filesystem-only). | `USER_SKILLS_DIR/<slug>/` is created/removed. |
| Design system install / uninstall | none. | `USER_DESIGN_SYSTEMS_DIR/<slug>/`. |
| Plugin install / uninstall / upgrade / apply / trust | plugin tables (`migratePlugins` in `plugins/persistence.ts`). | Plugin staging dirs under `RUNTIME_DATA_DIR`; couldn't determine exact layout without reading `plugins/index.ts`. |
| Marketplace add / refresh / trust / delete | plugin tables. | none on the project side. |
| Memory write / extract / index | memory tables (migration in `memory.ts`). | none. |
| Deployment config | none. | Encrypted/plain provider config file. |
| `POST /api/artifacts/save` | none. | `ARTIFACTS_DIR/<stamp>-<slug>/index.html`. |
| `POST /api/upload` | none. | Multer staging only — not project state. |
| Codex pets sync | none in app SQLite. | `${CODEX_HOME:-~/.codex}/pets/` — outside `RUNTIME_DATA_DIR`. |

---

## 3. Atomicity and ordering

This section answers the question "if MCP wraps each write with `git add . && git commit`, how many filesystem changes is the agent committing?"

### 3.1 Project create

`POST /api/projects` order (`project-routes.ts:184-292`):

1. `insertProject(db, …)` (single SQLite `INSERT` in `db.ts:511`).
2. `insertConversation(db, …)` (single `INSERT`).
3. Plugin snapshot resolution (`resolvePluginSnapshot`) — may write an `applied_plugin_snapshots` row.
4. Template-seeded only: `ensureProject` (`mkdir -p`), then for each template file `writeProjectFile` (one `writeFile` + optional manifest `writeFile`).

There is **no surrounding SQLite transaction and no rollback**. A crash between step 1 and step 2 leaves a project with no conversation. A crash mid-template-seed leaves a partial file tree alongside the row.

The single SQLite transaction in the entire `db.ts` is at line 1439 (inside an unrelated migration). Project creation does not use it.

### 3.2 Project delete

`project-routes.ts:390`:

1. `dbDeleteProject(db, id)` — single `DELETE FROM projects WHERE id = ?` (CASCADE clears conversations/messages/preview_comments/tabs/deployments). Plugin and live-artifact tables are *not* hooked into this cascade; couldn't determine without reading `plugins/persistence.ts` whether plugin snapshot rows survive.
2. `removeProjectDir(PROJECTS_DIR, id).catch(() => {})` — `rm -rf <PROJECTS_DIR>/<id>/`.

The `.catch(() => {})` swallows filesystem errors silently. For folder-imported projects (`metadata.baseDir`) `removeProjectDir` still targets `<PROJECTS_DIR>/<id>/` rather than the user's folder, so the user's files are not deleted — that's safe but means leftover state (the project dir was never created in the first place, so `rm` is a no-op).

Order matters: SQLite row goes first. A crash between steps leaves an orphan directory referencing a deleted project — harmless on disk but invisible in the UI.

### 3.3 Project file write

`writeProjectFile` in `projects.ts:615-700`:

1. `ensureProject` (`mkdir -p` of the project dir).
2. `resolveSafeReal(dir, name)` — symlink-aware path resolution.
3. `mkdir -p path.dirname(target)` for nested writes.
4. Optional stub-guard scan of `dirname(target)` (read-only).
5. `writeFile(target, body)` — **direct overwrite, no tmp + rename**.
6. If `artifactManifest` was supplied: `writeFile(<name>.artifact.json, …)` — a second `writeFile`.
7. `stat(target)` to build the response.

So a single API call can write 1 or 2 files, neither atomically. A crash between step 5 and step 6 leaves a content file with a stale or missing sidecar. Concurrent writes to the same name race at the kernel level — last writer wins on the content, then again on the sidecar.

### 3.4 Project file rename

`renameProjectFile` in `projects.ts:730-800`:

1. `stat` project dir, then `resolveSafeReal` source.
2. `lstat` source, reject if not a regular file.
3. `resolveSafeReal` target; reject if exists.
4. `prepareArtifactManifestRename` — reads the existing sidecar.
5. `mkdir -p dirname(target)`.
6. `renameFilePath(source, target, { noOverwrite: true })` — POSIX rename.
7. `commitArtifactManifestRename` — rewrites the sidecar with the new identifier (`writeFile` at the **old** path) and then renames it to the new path.

The content rename in step 6 is atomic. The sidecar rewrite+rename in step 7 is two operations. A crash between 6 and 7 leaves the content at the new name but the sidecar at the old path with stale identifier.

### 3.5 Project file delete

`deleteProjectFile` in `projects.ts:724`: a single `unlink`. The `.artifact.json` sidecar is **not** removed alongside — couldn't determine from source whether it's collected by anything later; on the evidence in `projects.ts` it leaks.

### 3.6 Conversations, messages, preview comments, tabs

All single-statement SQLite writes, no surrounding transaction except `setTabs` (`db.ts:1439` — the one `db.transaction(...)` in the codebase) which replaces a project's tab set atomically.

### 3.7 Live artifacts

`live-artifacts/store.ts:1-3` imports `rename` — there is an atomic write helper present, but I didn't read deeply enough to verify every callsite uses tmp+rename. The directory layout (`refresh.lock.json` plus `refresh-state.json`) suggests the refresh path uses a lockfile to serialize concurrent refreshes against the same artifact, but couldn't determine without reading `refresh-service.ts` whether lock acquisition is fully atomic.

### 3.8 SQLite + filesystem joint operations

No mutation in the daemon wraps both an SQLite write and a filesystem write in a single transaction. The pattern everywhere is:

- SQLite write → filesystem write (project create with template; rename rewriting `.artifact.json`).
- SQLite write → filesystem `rm` (project delete).

If the second step fails after the first commits, state diverges. Cleanup logic exists in only one place: `removeProjectDir(...).catch(() => {})` after `dbDeleteProject` — and "cleanup" is the wrong word for `.catch(() => {})`. There is no scheduled reaper, no startup reconciliation, and no `consistency_check` of the disk against the row set.

---

## 4. Blockers for git auto-commit

Plan: every MCP write tool ends with `cd ~/.od/projects/<id> && git add . && git commit -m '<tool> <args>'`.

What breaks that:

1. **Folder-imported projects don't live under `~/.od/projects/`.** When `metadata.baseDir` is set, the project root is the user's chosen folder. Auto-committing inside *that* repo would clobber the user's own git state. MCP must detect baseDir and either skip the commit or refuse to write at all for folder-imported projects. This is the single largest carve-out.

2. **Live artifacts write `.live-artifacts/<id>/refreshes.jsonl`, `refresh.lock.json`, `refresh-state.json`, and `snapshots/`.** The `refreshes.jsonl` append, the lockfile churn during refresh, and any snapshot bytes will accumulate. Committing every refresh inflates the repo fast; the lockfile in particular changes on every refresh attempt and would surface in every diff. Needs `.gitignore`:

   ```
   .live-artifacts/*/refresh.lock.json
   .live-artifacts/*/refresh-state.json
   .live-artifacts/*/refreshes.jsonl
   .live-artifacts/*/snapshots/
   ```

   Then the canonical `artifact.json`, `template.html`, `index.html` would still be tracked, which is what we want.

3. **Binary blobs.** Project files include uploaded images, generated MP4/WebP/PNG via `/api/projects/:id/media/generate`, user-uploaded PDFs/docs that the document preview pipeline reads. Multer uploads through `/api/projects/:id/files` (multipart) can be arbitrary bytes. Committing those is fine for small images but bad for video. No size cap is enforced before write; couldn't determine from source whether multer has a global size cap (would need to read the uploads helper in `server-context.ts`). MCP either needs an LFS strategy, a size cutoff, or `.gitignore` glob for known-binary kinds (`*.mp4`, `*.webm`, `*.wav`, `*.mp3`, large `*.png`).

4. **Concurrent writes during long agent runs.** A run can spawn the agent CLI as a child process (`runs.ts:159` — `run.child`). The agent writes files via `/api/projects/:id/files` repeatedly. If MCP commits per *tool call*, that's one commit per file. If MCP commits per *run*, it has to know when the run is done — and the run terminates asynchronously via the `runs.wait()` promise in `chat-routes.ts:24` or the inline `server.ts:9561` equivalent. A simple "commit after the HTTP response returns" approach commits one file at a time, which matches the per-tool design.

5. **`.artifact.json` sidecars.** Every artifact-bearing write produces two files. Auto-commit captures both, which is what we want, but the rename path's "write old sidecar, rename it" pattern means a rename produces two commits' worth of diff in one operation if the agent commits at intermediate points. Single end-of-tool commit is fine.

6. **Project delete clears the project tree but `.catch(()=>{})` hides FS failures.** If the directory has uncommitted MCP-managed files when `DELETE /api/projects/:id` fires, they vanish with no record. MCP can't intercept this (it's not an MCP write). Either tolerate it or refuse to expose `delete_project` as an MCP tool initially.

7. **Project file rename is not single-shot on disk.** The content rename plus the sidecar's two-step rewrite means an interruption can leave a half-renamed pair. `git add .` after the *successful* response is fine — both files have settled by then. The risk is only if MCP commits on a partial failure.

8. **Background writers the daemon performs outside an API call:**
   - The `refreshLiveArtifact` flow can write to `.live-artifacts/<id>/` from a non-MCP code path (chokidar-driven, scheduled refresh, refresh service).
   - `project-watchers.ts` is a watcher, not a writer (`subscribeFileEvents`), so it doesn't mutate; couldn't fully confirm without reading the file.
   - `media-tasks.ts` `persistMediaTask` writes media artifacts to disk on task completion, asynchronous to the `/api/projects/:id/media/generate` response (which is a 202 with a `taskId`).
   - Telemetry / analytics never touch project disk state.
   - The routine scheduler can fire a `POST /api/runs` equivalent at scheduled times. That run can write files outside MCP's request lifecycle entirely.

   For (8), MCP should treat any commit it does as a *snapshot of whatever was in the working tree at the time*, accepting that scheduled/refresh writes can also be folded into the next MCP commit. That's fine for safety; not fine for crisp attribution.

9. **Cross-project writes in one call.** `POST /api/templates` reads files from a source project but writes only to SQLite (not the other project's disk). I didn't find a single write endpoint that mutates two project directories in one call. Live-artifact refresh stays within one project. Deploy reads, doesn't write to the project tree.

---

## 5. Run-trigger surface

The single most expensive endpoint to expose via MCP.

**Canonical: `POST /api/runs` at `server.ts:9561-9676`** (the variant in `chat-routes.ts:70` is shadowed because the inline definition is registered first).

**Required:** none strictly enforced; the run service tolerates a body of `{}`. In practice:
- `projectId` (string) — required for plugin resolution and for the run to attach to anything; without it the run is orphaned.
- `conversationId` (string) — implied required for the messages-side bookkeeping (the assistant message lands here).
- `message` or `currentPrompt` (string) — the prompt itself. Without it the agent has nothing to do.

**Optional:**
- `assistantMessageId` — pre-allocated message row id for the assistant's reply (lets the SSE stream reconcile with `messages` on refresh).
- `clientRequestId`
- `agentId` — selects which adapter (Claude Code, Claude API, Codex, Qoder, Copilot, Pi/ACP, custom).
- `model` — e.g. `claude-sonnet-4-6`.
- `skillId`, `designSystemId` — feed into system prompt assembly.
- `attachments[]`
- `pluginId`, `appliedPluginSnapshotId` — plugin resolution path. When neither is supplied, the daemon falls back to the bundled scenario plugin for the project's `metadata.kind` (silent fallback; missing fallback is non-fatal).
- `x-od-client` request header (`desktop` | `web`) — recorded on the run.

**Response:** `202 Accepted` with `{ runId, appliedPluginSnapshotId?, pluginId? }`. **Asynchronous** — the body returns immediately; the actual agent stream is consumed via:
- `GET /api/runs/:id/events` (SSE, raw OD events)
- `GET /api/runs/:id/agui` (SSE, AG-UI–encoded)
- `GET /api/runs/:id` (single-shot status)

**Cost:**
- The daemon shells out to the agent CLI (`startChatRun` → `runs.start`, see `chat-routes.ts:38` / `runs.ts:104`). The cost lives in the underlying provider — Anthropic API, OpenAI, etc. Token cost is per-prompt-token plus per-output-token. The daemon does emit `run_created` + `run_finished` to PostHog with `input_tokens` / `output_tokens` pulled from the agent's `usage` events (`chat-routes.ts:165-208`); it does *not* enforce a budget or refuse runs over a threshold.
- Plugins (`appliedPluginSnapshotId`) may layer in a pipeline (`firePipelineForRun` at `server.ts:9667`) that runs additional stages — couldn't determine without reading the pipeline runner whether each stage is itself a billable LLM call.
- Tool use inside the run can write files (`/api/projects/:id/files`), create live artifacts, hit the proxy stream endpoints. Each of those is its own cost.

In short: a single `POST /api/runs` is potentially a multi-stage, multi-tool, unbounded-token operation. **This is the single hardest thing to rate-limit responsibly** — the daemon currently does nothing.

**Cancellation:** `POST /api/runs/:id/cancel` at `server.ts:9747` (and `chat-routes.ts:232`). Implementation in `runs.ts:168`: sets `cancelRequested`, calls `acpSession.abort()` (graceful) with a SIGTERM fallback after `PI_ABORT_GRACE_MS` (default 3000 ms). If the child is already dead it calls `finish(run, 'canceled', null, 'SIGTERM')`.

**Tool-result feedback path:** `POST /api/runs/:id/tool-result` (`chat-routes.ts:247`) — feeds a tool result JSONL line into the still-open stdin of the agent child. Errors: 410 GONE for terminal/closed runs, 400 for stdin in non-interactive mode. This is the surface to use if MCP wants to answer an `AskUserQuestion` from outside the OD UI.

**Routine variant:** `POST /api/routines/:id/run` at `routine-routes.ts:197` is **run trigger #2** — synchronous, creates/reuses a project + conversation + agent run, inserts a `routine_runs` row. Cost identical to a manual run, plus the bookkeeping rows.

Rate-limit design notes:
- One natural rate-limit key is `(projectId, agentId)` or `(projectId, model)`.
- The daemon already labels runs with `clientType` from `x-od-client` (`server.ts:9637` via `runs.ts` flow) — MCP should set a distinct value (e.g. `mcp`) so rate limits or budgets keyed off `clientType` work cleanly. **Couldn't determine** whether `clientType` is honored anywhere on the rate-limit side; today it looks like analytics only.
- A `dryRun` flag does not exist. If MCP wants to expose a "what would this cost" preview, it has to be the MCP layer's invention.

---

## 6. Open questions

Things this audit could not resolve from source-reading alone:

1. **Plugin filesystem layout under `RUNTIME_DATA_DIR`.** I traced plugin SQLite tables and the upload endpoints but didn't open `plugins/index.ts` / `plugins/persistence.ts` deeply enough to enumerate `RUNTIME_DATA_DIR/plugins/<id>/…` contents. Needed if MCP wants to expose plugin-install to agents.

2. **`media-tasks.ts` output path.** `/api/projects/:id/media/generate` returns `{ taskId }` and the actual file lands later. The target path (and whether it goes into the project tree, the artifacts dir, or a media-specific subdir) is computed in `media.ts:generateMedia`. Needs a focused read before we can claim "media outputs are project files".

3. **Multer global limits.** The `upload` and `handleProjectUpload` factories live in `server-context.ts`. No explicit size cap is visible in the routes; if there's no global limit, a malicious agent can fill the disk via `/api/projects/:id/files`.

4. **Live-artifact write atomicity.** I confirmed the directory layout and the presence of a lockfile but did not verify every write goes through tmp+rename. `refresh.ts` and `refresh-service.ts` would settle it.

5. **`project-watchers.ts`.** Confirmed it's a chokidar subscription path that emits SSE events. Did not verify it never writes (e.g. cache files). Worth a 30-second read before MCP commits to "watchers don't mutate".

6. **Tool-token issuance.** `authorizeToolRequest` and the live-artifact tool endpoints accept tokens but I didn't trace where tokens are minted. MCP tools that need tool-token semantics (e.g. to call `/api/tools/live-artifacts/create` rather than the open `PATCH` variant) need to know that.

7. **`runtimes/` and `pi-rpc.ts`.** The ACP / pi-rpc adapters do most of the agent-side I/O. If MCP wants to model "agent writes a file" as something other than an HTTP write through the daemon, the actual write path inside those adapters needs an audit. For now, treat the HTTP surface as the canonical write surface.

8. **GenUI surfaces.** `POST /api/runs/:runId/genui/:surfaceId/respond` and friends look like they let an out-of-band caller answer interactive forms attached to a running agent. Couldn't determine without a deeper read whether this can be invoked from MCP without holding the run's SSE stream open.

9. **Routine scheduler triggering writes.** Routines fire on a schedule and produce runs; runs can write files. That means at any moment a project's tree can change without an MCP call. The git-auto-commit story has to either accept those changes will fold into the next MCP commit, or have MCP commit-from-watcher (out of scope for the planned three-prong design).

10. **Whether `chat-routes.ts` was *meant* to shadow the inline `server.ts` definitions or vice versa.** The duplication looks like an in-flight extraction — somebody split the monolithic `server.ts` into route modules but stopped at the chat surface. For mcp-write planning we can ignore the duplication and treat the inline `server.ts` block as canonical for runs/chat. For the next refactor, this is the obvious lever.
