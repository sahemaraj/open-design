// Per-project rate limiter for `trigger_run`.
// See docs/internal/mcp-write-design.md §4.
//
// State is in-memory (Map<projectId, …>) and resets on daemon restart.
// Per design: there is one daemon per RUNTIME_DATA_DIR, so process-local
// state is correct by construction; persistence to SQLite is intentionally
// deferred (a circuit breaker, not an audit log).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface RateLimitConfig {
  max_concurrent_per_project: number;
  max_per_project_per_hour: number;
  max_per_project_per_day: number;
}

export interface RateLimitCheck {
  allowed: boolean;
  exceeded_dimension?: 'concurrent' | 'per_hour' | 'per_day';
  current_count?: number;
  retry_after_seconds?: number;
}

const DEFAULTS: RateLimitConfig = {
  max_concurrent_per_project: 3,
  max_per_project_per_hour: 10,
  max_per_project_per_day: 50,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface ProjectWindow {
  concurrent: number;
  hourTimestamps: number[];
  dayTimestamps: number[];
}

const state = new Map<string, ProjectWindow>();

let cachedConfig: RateLimitConfig | null = null;

export function loadConfig(): RateLimitConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = path.join(os.homedir(), '.od', 'mcp-write.json');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    cachedConfig = { ...DEFAULTS };
    return cachedConfig;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    cachedConfig = { ...DEFAULTS };
    return cachedConfig;
  }
  const trigger = (parsed as { trigger_run?: Partial<RateLimitConfig> })?.trigger_run ?? {};
  cachedConfig = {
    max_concurrent_per_project: pickPositive(trigger.max_concurrent_per_project, DEFAULTS.max_concurrent_per_project),
    max_per_project_per_hour: pickPositive(trigger.max_per_project_per_hour, DEFAULTS.max_per_project_per_hour),
    max_per_project_per_day: pickPositive(trigger.max_per_project_per_day, DEFAULTS.max_per_project_per_day),
  };
  return cachedConfig;
}

function pickPositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function getWindow(projectId: string): ProjectWindow {
  let w = state.get(projectId);
  if (!w) {
    w = { concurrent: 0, hourTimestamps: [], dayTimestamps: [] };
    state.set(projectId, w);
  }
  return w;
}

function prune(timestamps: number[], cutoff: number): void {
  let drop = 0;
  while (drop < timestamps.length && (timestamps[drop] as number) < cutoff) drop++;
  if (drop > 0) timestamps.splice(0, drop);
}

export function checkAndRecord(projectId: string, now: number = Date.now()): RateLimitCheck {
  const cfg = loadConfig();
  const w = getWindow(projectId);
  prune(w.hourTimestamps, now - HOUR_MS);
  prune(w.dayTimestamps, now - DAY_MS);

  if (w.concurrent >= cfg.max_concurrent_per_project) {
    return {
      allowed: false,
      exceeded_dimension: 'concurrent',
      current_count: w.concurrent,
    };
  }
  if (w.hourTimestamps.length >= cfg.max_per_project_per_hour) {
    const oldest = w.hourTimestamps[0] as number;
    return {
      allowed: false,
      exceeded_dimension: 'per_hour',
      current_count: w.hourTimestamps.length,
      retry_after_seconds: Math.max(0, Math.ceil((oldest + HOUR_MS - now) / 1000)),
    };
  }
  if (w.dayTimestamps.length >= cfg.max_per_project_per_day) {
    const oldest = w.dayTimestamps[0] as number;
    return {
      allowed: false,
      exceeded_dimension: 'per_day',
      current_count: w.dayTimestamps.length,
      retry_after_seconds: Math.max(0, Math.ceil((oldest + DAY_MS - now) / 1000)),
    };
  }

  w.concurrent += 1;
  w.hourTimestamps.push(now);
  w.dayTimestamps.push(now);
  return { allowed: true };
}

export function recordCompletion(projectId: string): void {
  const w = state.get(projectId);
  if (!w) return;
  if (w.concurrent > 0) w.concurrent -= 1;
}

// Test-only.
export function _resetForTests(): void {
  state.clear();
  cachedConfig = null;
}
