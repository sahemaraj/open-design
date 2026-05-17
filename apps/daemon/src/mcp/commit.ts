// Git auto-commit lifecycle for MCP write operations.
// See docs/internal/mcp-write-design.md §5.
//
// Author identity is hardcoded as `mcp-write <mcp@open-design.local>` per
// design §5. The "configurable override" mentioned in the design is deferred
// to a later slice; v1 has no override mechanism here.
//
// Concurrent-write race: design §5 explicitly accepts last-writer-wins.
// We do nothing special — two concurrent autoCommit calls on the same
// projectDir may interleave `git add`/`git commit` and produce out-of-order
// commits. A project-level lock would only displace the underlying kernel
// race documented in audit §3.3.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { makeError } from './errors.js';

const execFileAsync = promisify(execFile);

const AUTHOR = 'mcp-write <mcp@open-design.local>';

const GITIGNORE_CONTENTS = `# Live-artifact churn (per audit §4 item 2)
.live-artifacts/*/refresh.lock.json
.live-artifacts/*/refresh-state.json
.live-artifacts/*/refreshes.jsonl
.live-artifacts/*/snapshots/

# Binary blobs (per audit §4 item 3)
*.mp4
*.webm
*.wav
*.mp3

# Trash directory (separate from git, see design §6)
.trash/
`;

export interface CommitOptions {
  projectDir: string;
  tool: string;
  summary: string;
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  bootstrapped: boolean;
}

export async function autoCommit(opts: CommitOptions): Promise<CommitResult> {
  const { projectDir, tool, summary } = opts;

  if (!path.isAbsolute(projectDir)) {
    throw makeError('INVALID_PATH', `projectDir must be absolute: "${projectDir}"`, {
      details: { projectDir },
    });
  }
  let stat;
  try {
    stat = await fs.stat(projectDir);
  } catch (err) {
    throw makeError('INVALID_PATH', `projectDir does not exist: "${projectDir}"`, {
      details: { projectDir, cause: errMsg(err) },
    });
  }
  if (!stat.isDirectory()) {
    throw makeError('INVALID_PATH', `projectDir is not a directory: "${projectDir}"`, {
      details: { projectDir },
    });
  }

  const gitDir = path.join(projectDir, '.git');
  let bootstrapped = false;
  try {
    await fs.access(gitDir);
  } catch {
    await bootstrap(projectDir);
    bootstrapped = true;
  }

  await runGit(projectDir, ['add', '.']);

  // `git diff --cached --quiet` exits 0 if nothing is staged, 1 if there are
  // staged changes. Design §5 "nothing to commit": warn, do not error.
  const diffResult = await runGitAllowExitCode(projectDir, ['diff', '--cached', '--quiet'], [0, 1]);
  if (diffResult.code === 0) {
    console.warn(`[mcp-write] autoCommit: nothing to commit in ${projectDir} (tool=${tool})`);
    return { committed: false, bootstrapped };
  }

  const message = `mcp(${tool}): ${summary}`;
  await runGit(projectDir, ['commit', '-m', message, '--author', AUTHOR]);
  const { stdout } = await runGit(projectDir, ['rev-parse', 'HEAD']);
  const sha = stdout.trim();
  return { committed: true, sha, bootstrapped };
}

async function bootstrap(projectDir: string): Promise<void> {
  await runGit(projectDir, ['init']);
  await fs.writeFile(path.join(projectDir, '.gitignore'), GITIGNORE_CONTENTS, 'utf8');
  await runGit(projectDir, [
    'commit',
    '--allow-empty',
    '-m',
    'chore: mcp-write init',
    '--author',
    AUTHOR,
  ]);
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown };
    if (e.code === 'ENOENT') {
      throw makeError('GIT_UNAVAILABLE', 'git binary not available', {
        details: { projectDir: cwd },
      });
    }
    const exitCode = typeof e.code === 'number' ? e.code : -1;
    throw makeError(
      'GIT_COMMIT_FAILED',
      `git ${args.join(' ')} failed (exit ${exitCode}) in ${cwd}`,
      { details: { projectDir: cwd, args, exitCode, stderr: e.stderr ?? '' } },
    );
  }
}

async function runGitAllowExitCode(
  cwd: string,
  args: string[],
  allowed: number[],
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown };
    if (e.code === 'ENOENT') {
      throw makeError('GIT_UNAVAILABLE', 'git binary not available', {
        details: { projectDir: cwd },
      });
    }
    const exitCode = typeof e.code === 'number' ? e.code : -1;
    if (allowed.includes(exitCode)) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: exitCode };
    }
    throw makeError(
      'GIT_COMMIT_FAILED',
      `git ${args.join(' ')} failed (exit ${exitCode}) in ${cwd}`,
      { details: { projectDir: cwd, args, exitCode, stderr: e.stderr ?? '' } },
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
