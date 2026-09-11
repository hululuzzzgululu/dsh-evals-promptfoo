/** Safe, bounded persisted representation of the Compact Eval View. */
import type { RunResult } from '@deepseek-ai/dsh-sdk-client';

import type {
  DshEvalMetadataV1,
  DshSessionView,
  DshToolCallView,
} from './projection.js';

export const DEFAULT_EVAL_DATA_LIMITS = {
  maxStringLength: 1_024,
  maxToolCalls: 100,
  maxSessions: 50,
  maxWarnings: 20,
  maxSummaryItems: 50,
} as const;

/** Caller-controlled additions to the default persisted-data policy. */
export interface DshEvalDataPolicy {
  maxStringLength?: number;
  maxToolCalls?: number;
  maxSessions?: number;
  maxWarnings?: number;
  maxSummaryItems?: number;
  /** Case-insensitive object key names whose values are always replaced. */
  additionalSecretKeys?: string[];
  /** Dot-separated metadata paths; `*` matches one object key or array index. */
  additionalSecretPaths?: string[];
  /** Include unbounded, unredacted SDK events. Unsafe and off by default. */
  rawEvents?: boolean;
}

interface Limits {
  maxStringLength: number;
  maxToolCalls: number;
  maxSessions: number;
  maxWarnings: number;
  maxSummaryItems: number;
}

interface SanitizeState {
  limits: Limits;
  secretKeys: Set<string>;
  secretPaths: string[][];
  truncatedStrings: number;
  redactedValues: number;
  circularValues: number;
  generatedWarnings: string[];
  ancestors: WeakSet<object>;
}

const DEFAULT_SECRET_KEYS = [
  'apiKey',
  'authorization',
  'authToken',
  'accessToken',
  'refreshToken',
  'token',
  'password',
  'passwd',
  'secret',
  'clientSecret',
  'privateKey',
  'cookie',
  'setCookie',
] as const;

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function limit(value: number | undefined, fallback: number, name: string, minimum = 0): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(`evalData.${name} must be an integer >= ${minimum}`);
  }
  return resolved;
}

function resolveLimits(policy: DshEvalDataPolicy): Limits {
  return {
    maxStringLength: limit(
      policy.maxStringLength,
      DEFAULT_EVAL_DATA_LIMITS.maxStringLength,
      'maxStringLength',
      16,
    ),
    maxToolCalls: limit(policy.maxToolCalls, DEFAULT_EVAL_DATA_LIMITS.maxToolCalls, 'maxToolCalls'),
    maxSessions: limit(policy.maxSessions, DEFAULT_EVAL_DATA_LIMITS.maxSessions, 'maxSessions'),
    maxWarnings: limit(policy.maxWarnings, DEFAULT_EVAL_DATA_LIMITS.maxWarnings, 'maxWarnings', 1),
    maxSummaryItems: limit(
      policy.maxSummaryItems,
      DEFAULT_EVAL_DATA_LIMITS.maxSummaryItems,
      'maxSummaryItems',
    ),
  };
}

function parseSecretPath(path: string): string[] {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error('evalData.additionalSecretPaths entries must not be empty');
  return segments.map((segment) => (segment === '*' ? '*' : segment.toLowerCase()));
}

function isSecretPath(path: readonly string[], patterns: readonly string[][]): boolean {
  return patterns.some(
    (pattern) =>
      pattern.length === path.length &&
      pattern.every((segment, index) => segment === '*' || segment === path[index]?.toLowerCase()),
  );
}

function redactPatterns(value: string): string {
  return value
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi, '[REDACTED]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[a-z0-9]{20,}\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|token|password|passwd|secret|authorization)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
      '$1[REDACTED]',
    );
}

function sanitizeString(value: string, state: SanitizeState): string {
  const redacted = redactPatterns(value);
  if (redacted !== value) state.redactedValues += 1;
  if (redacted.length <= state.limits.maxStringLength) return redacted;
  state.truncatedStrings += 1;
  const suffix = '…[truncated]';
  return `${redacted.slice(0, state.limits.maxStringLength - suffix.length)}${suffix}`;
}

function sanitizeUnknown(value: unknown, path: string[], state: SanitizeState): unknown {
  if (typeof value === 'string') return sanitizeString(value, state);
  if (value === null || typeof value !== 'object') return value;
  if (state.ancestors.has(value)) {
    state.circularValues += 1;
    return '[Circular]';
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => sanitizeUnknown(entry, [...path, String(index)], state));
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const childPath = [...path, key];
      if (state.secretKeys.has(normalizeKey(key)) || isSecretPath(childPath, state.secretPaths)) {
        output[key] = '[REDACTED]';
        state.redactedValues += 1;
      } else {
        output[key] = sanitizeUnknown(entry, childPath, state);
      }
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function refreshRawArguments(tool: DshToolCallView, state: SanitizeState): void {
  if (tool.parsedArguments === undefined) return;
  const serialized = JSON.stringify(tool.parsedArguments);
  tool.rawArguments = sanitizeString(serialized, state);
}

function capTools(
  tools: DshToolCallView[],
  maximum: number,
  location: string,
  state: SanitizeState,
): DshToolCallView[] {
  const omitted = Math.max(0, tools.length - maximum);
  if (omitted > 0) {
    state.generatedWarnings.push(
      `${location} omitted ${omitted} Tool call(s) because maxToolCalls=${maximum}`,
    );
  }
  const retained = tools.slice(0, maximum);
  for (const tool of retained) {
    refreshRawArguments(tool, state);
    if (tool.result !== undefined && tool.result.contentTypes.length > state.limits.maxSummaryItems) {
      const count = tool.result.contentTypes.length - state.limits.maxSummaryItems;
      tool.result.contentTypes = tool.result.contentTypes.slice(0, state.limits.maxSummaryItems);
      state.generatedWarnings.push(
        `${location} omitted ${count} Tool result summary item(s) because maxSummaryItems=${state.limits.maxSummaryItems}`,
      );
    }
  }
  return retained;
}

function capSessionTools(sessions: DshSessionView[], state: SanitizeState): void {
  let remaining = state.limits.maxToolCalls;
  let omitted = 0;
  for (const session of sessions) {
    const retained = session.tools.slice(0, remaining);
    omitted += session.tools.length - retained.length;
    session.tools = retained;
    remaining -= retained.length;
    for (const tool of retained) refreshRawArguments(tool, state);
  }
  if (omitted > 0) {
    state.generatedWarnings.push(
      `sessions omitted ${omitted} Tool call(s) because maxToolCalls=${state.limits.maxToolCalls}`,
    );
  }
}

function boundedWarnings(warnings: string[], state: SanitizeState): string[] {
  const generated = [...state.generatedWarnings];
  if (state.redactedValues > 0) generated.push(`redactedValues=${state.redactedValues}`);
  if (state.truncatedStrings > 0) {
    generated.push(`maxStringLength=${state.limits.maxStringLength}; truncated=${state.truncatedStrings}`);
  }
  if (state.circularValues > 0) generated.push(`circularValues=${state.circularValues}; replaced`);
  const combined = [...warnings, ...generated];
  const fit = (values: string[]) =>
    values.map((value) => {
      if (value.length <= state.limits.maxStringLength) return value;
      const suffix = '…[truncated]';
      return `${value.slice(0, state.limits.maxStringLength - suffix.length)}${suffix}`;
    });
  if (combined.length <= state.limits.maxWarnings) return fit(combined);
  if (state.limits.maxWarnings === 1) {
    return fit([`warning entries were omitted because maxWarnings=${state.limits.maxWarnings}`]);
  }
  return fit([
    ...combined.slice(0, state.limits.maxWarnings - 1),
    `${combined.length - state.limits.maxWarnings + 1} warning entries were omitted because maxWarnings=${state.limits.maxWarnings}`,
  ]);
}

/**
 * Redact and bound metadata before Promptfoo serializes it. Aggregate counts
 * retain their original values even when detail arrays are capped.
 */
export function protectEvalMetadata(
  metadata: DshEvalMetadataV1,
  result: RunResult,
  policy: DshEvalDataPolicy = {},
): DshEvalMetadataV1 {
  const limits = resolveLimits(policy);
  const state: SanitizeState = {
    limits,
    secretKeys: new Set(
      [...DEFAULT_SECRET_KEYS, ...(policy.additionalSecretKeys ?? [])].map(normalizeKey),
    ),
    secretPaths: (policy.additionalSecretPaths ?? []).map(parseSecretPath),
    truncatedStrings: 0,
    redactedValues: 0,
    circularValues: 0,
    generatedWarnings: [],
    ancestors: new WeakSet(),
  };
  const safe = sanitizeUnknown(metadata, [], state) as DshEvalMetadataV1;

  safe.root.tools = capTools(safe.root.tools, limits.maxToolCalls, 'root.tools', state);
  safe.observableTree.tools = capTools(
    safe.observableTree.tools,
    limits.maxToolCalls,
    'observableTree.tools',
    state,
  );
  if (safe.sessions.length > limits.maxSessions) {
    state.generatedWarnings.push(
      `sessions omitted ${safe.sessions.length - limits.maxSessions} Session(s) because maxSessions=${limits.maxSessions}`,
    );
    safe.sessions = safe.sessions.slice(0, limits.maxSessions);
  }
  capSessionTools(safe.sessions, state);
  if (safe.runtime.patches.length > limits.maxSummaryItems) {
    state.generatedWarnings.push(
      `runtime.patches omitted ${safe.runtime.patches.length - limits.maxSummaryItems} item(s) because maxSummaryItems=${limits.maxSummaryItems}`,
    );
    safe.runtime.patches = safe.runtime.patches.slice(0, limits.maxSummaryItems);
  }
  if (policy.rawEvents === true) {
    state.generatedWarnings.push(
      'rawEvents is enabled: persisted SDK events may contain prompts, Tool results, credentials, and large payloads; do not use for routine regression runs',
    );
    safe.rawEvents = {
      events: result.events,
      notifications: result.notifications,
    };
  }
  safe.warnings = boundedWarnings(safe.warnings, state);
  return safe;
}
