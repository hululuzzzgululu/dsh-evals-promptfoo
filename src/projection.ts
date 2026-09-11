/**
 * Versioned, compact projections from DSH owned-activity events to values that
 * Promptfoo can persist and aggregate.
 *
 * @module dsh-evals-promptfoo/projection
 */
import { basename } from 'node:path';

import type { HarnessNotification, RunResult } from '@deepseek-ai/dsh-sdk-client';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { TokenUsage as PromptfooTokenUsage } from 'promptfoo';

import { getFinishReason } from './events.js';
import type { DshProviderConfig } from './runtime.js';

export const DSH_EVAL_SCHEMA_VERSION = 1 as const;
export const DSH_ADAPTER_VERSION = '0.1.0';
export const DSH_SDK_VERSION = '0.1.5-alpha.2';

/** Stable metric names emitted by the companion Promptfoo assertion. */
export const ROOT_METRIC_NAMES = {
  steps: 'dsh.root.steps',
  modelCalls: 'dsh.root.modelCalls',
  toolCalls: 'dsh.root.toolCalls',
} as const;

export const TREE_METRIC_NAMES = {
  sessions: 'dsh.tree.sessions',
  steps: 'dsh.tree.steps',
  modelCalls: 'dsh.tree.modelCalls',
  toolCalls: 'dsh.tree.toolCalls',
} as const;

/** Token buckets retain DSH's disjoint input accounting. */
export interface DshTokenUsage {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  requests: number;
}

/** Compact execution facts for one selected event scope. */
export interface DshExecutionSummary {
  finishReason: string;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  tokenUsage: DshTokenUsage;
  tools: DshToolCallView[];
}

export interface DshSessionView extends DshExecutionSummary {
  sessionId: string;
  parentSessionId?: string;
  subagent?: {
    status: string;
    stopReason: string;
  };
}

export interface DshObservableTreeSummary {
  visibility: {
    scope: 'runtime-notifications';
    completeness: 'observable-only';
    limitation: string;
  };
  sessionCount: number;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  tokenUsage: DshTokenUsage;
  tools: DshToolCallView[];
}

export interface DshToolResultSummary {
  blockCount: number;
  contentTypes: string[];
}

/** One root Tool invocation paired to its result by provider-issued identity. */
export interface DshToolCallView {
  sessionId: string;
  turn: number;
  step: number;
  callId: string;
  name: string;
  rawArguments: string;
  parsedArguments?: unknown;
  argumentParseError?: 'invalid JSON';
  status: 'succeeded' | 'error' | 'unpaired';
  result?: DshToolResultSummary;
  error?: { name: string; code: string };
}

/** Non-sensitive identity of the evaluated runtime. */
export interface DshRuntimeSummary {
  adapterVersion: string;
  sdkVersion: string;
  profile: string;
  patches: string[];
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

/** V1 metadata returned by the DSH Promptfoo provider. */
export interface DshEvalMetadataV1 {
  schemaVersion: typeof DSH_EVAL_SCHEMA_VERSION;
  rootSessionId: string;
  runtime: DshRuntimeSummary;
  root: DshExecutionSummary;
  observableTree: DshObservableTreeSummary;
  sessions: DshSessionView[];
  warnings: string[];
  /** Explicitly unsafe, opt-in wire data for one run. Absent by default. */
  rawEvents?: {
    events: unknown[];
    notifications: unknown[];
  };
}

/** A required DSH event shape was absent or malformed. */
export class DshProjectionError extends Error {
  override readonly name = 'DshProjectionError';
}

function emptyTokenUsage(): DshTokenUsage {
  return {
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    requests: 0,
  };
}

function mergeTokenUsage(target: DshTokenUsage, source: DshTokenUsage): void {
  target.uncachedInput += source.uncachedInput;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.total += source.total;
  target.requests += source.requests;
}

function requireTokenCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DshProjectionError(`model usage field ${field} must be a non-negative integer`);
  }
  return value;
}

/** Read the usage chunk retained in an unsuccessful assistant attempt. */
function attemptUsage(event: SessionEvent<'assistant/attempt'>): unknown {
  for (let index = event.data.stream.length - 1; index >= 0; index--) {
    const record = event.data.stream[index];
    if (record?.type === 'chunk' && record.chunk.type === 'usage') return record.chunk.usage;
  }
  return undefined;
}

function addUsage(target: DshTokenUsage, rawUsage: unknown): void {
  if (typeof rawUsage !== 'object' || rawUsage === null || Array.isArray(rawUsage)) {
    throw new DshProjectionError('model usage must be an object');
  }
  const usage = rawUsage as Record<string, unknown>;
  const uncachedInput = requireTokenCount(usage['inputTokens'], 'inputTokens');
  const output = requireTokenCount(usage['outputTokens'], 'outputTokens');
  const cacheRead =
    usage['cacheReadTokens'] === undefined
      ? 0
      : requireTokenCount(usage['cacheReadTokens'], 'cacheReadTokens');
  const cacheWrite =
    usage['cacheWriteTokens'] === undefined
      ? 0
      : requireTokenCount(usage['cacheWriteTokens'], 'cacheWriteTokens');
  const reasoning =
    usage['reasoningTokens'] === undefined
      ? 0
      : requireTokenCount(usage['reasoningTokens'], 'reasoningTokens');

  target.uncachedInput += uncachedInput;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.output += output;
  target.reasoning += reasoning;
  target.total += uncachedInput + cacheRead + cacheWrite + output;
}

function parseArguments(rawArguments: string):
  | { parsedArguments: unknown }
  | { argumentParseError: 'invalid JSON' } {
  try {
    return { parsedArguments: JSON.parse(rawArguments) as unknown };
  } catch {
    return { argumentParseError: 'invalid JSON' };
  }
}

function toolResultIdentity(event: SessionEvent<'tool/result'>): string {
  const callId = event.data.message.source.callId;
  if (typeof callId !== 'string' || callId.length === 0) {
    throw new DshProjectionError('tool/result message has no valid call identity');
  }
  const blockCallId = event.data.message.content[0]?.toolCallId;
  if (blockCallId !== callId) {
    throw new DshProjectionError('tool/result message and block call identities disagree');
  }
  return callId;
}

/** Pair root Tool calls and results without persisting result bodies. */
export function projectToolCalls(
  events: readonly SessionEvent[],
  sessionId: string,
  warnings: string[] = [],
): DshToolCallView[] {
  const calls = new Map<string, SessionEvent<'tool/call'>>();
  const results = new Map<string, SessionEvent<'tool/result'>>();

  for (const event of events) {
    if (event.type === 'tool/call') {
      const callId = String(event.data.callId);
      if (calls.has(callId)) {
        throw new DshProjectionError(`duplicate tool/call identity ${callId}`);
      }
      calls.set(callId, event);
    } else if (event.type === 'tool/result') {
      const callId = toolResultIdentity(event);
      if (results.has(callId)) {
        throw new DshProjectionError(`duplicate tool/result identity ${callId}`);
      }
      results.set(callId, event);
    }
  }

  for (const callId of results.keys()) {
    if (!calls.has(callId)) warnings.push(`root tool result ${callId} has no matching call`);
  }

  return [...calls.entries()].map(([callId, event]) => {
    const resultEvent = results.get(callId);
    const resultBlock = resultEvent?.data.message.content[0];
    const status =
      resultEvent === undefined
        ? 'unpaired'
        : resultEvent.data.error !== undefined || resultBlock?.isError === true
          ? 'error'
          : 'succeeded';
    return {
      sessionId,
      turn: event.data.turn,
      step: event.data.step,
      callId,
      name: event.data.name,
      rawArguments: event.data.arguments,
      ...parseArguments(event.data.arguments),
      status,
      ...(resultBlock === undefined
        ? {}
        : {
            result: {
              blockCount: resultBlock.content.length,
              contentTypes: resultBlock.content.map((block) => String(block.type)),
            },
          }),
      ...(resultEvent?.data.error === undefined ? {} : { error: resultEvent.data.error }),
    };
  });
}

/**
 * Project the root owned-activity interval. The final turn reason is required:
 * a successful SDK response without it cannot support trustworthy evaluation.
 */
export function summarizeRootEvents(
  events: readonly SessionEvent[],
  warnings: string[] = [],
  sessionId = 'root',
): DshExecutionSummary {
  const finishReason = getFinishReason(events);
  if (finishReason === undefined || finishReason.length === 0) {
    throw new DshProjectionError('root activity interval has no valid final turn/end reason');
  }

  return { ...summarizeSessionEvents(events, sessionId, warnings), finishReason };
}

function summarizeSessionEvents(
  events: readonly SessionEvent[],
  sessionId: string,
  warnings: string[],
): Omit<DshExecutionSummary, 'finishReason'> {
  let steps = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  const tokenUsage = emptyTokenUsage();

  for (const event of events) {
    if (event.type === 'step/end') steps += 1;
    if (event.type === 'tool/call') toolCalls += 1;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    modelCalls += 1;
    tokenUsage.requests += 1;
    const usage = event.type === 'assistant/message' ? event.data.usage : attemptUsage(event);
    if (usage === undefined) {
      warnings.push(
        `session ${sessionId} model call at event seq ${String(event.seq)} reported no token usage`,
      );
    } else {
      addUsage(tokenUsage, usage);
    }
  }
  return {
    steps,
    modelCalls,
    toolCalls,
    tokenUsage,
    tools: projectToolCalls(events, sessionId, warnings),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DshProjectionError(`${field} must be a non-empty string`);
  }
  return value;
}

function notificationEvent(notification: HarnessNotification): {
  sessionId: string;
  event: SessionEvent;
} {
  const sessionId = requiredString(notification.params['sessionId'], 'session.event sessionId');
  const rawEvent = notification.params['event'];
  if (!isRecord(rawEvent) || typeof rawEvent['type'] !== 'string') {
    throw new DshProjectionError('session.event has no valid event envelope');
  }
  return { sessionId, event: rawEvent as SessionEvent };
}

/** Project exactly the session events and lineage observable in RunResult notifications. */
export function projectObservableTree(
  notifications: readonly HarnessNotification[],
  rootSessionId: string,
  warnings: string[],
): { observableTree: DshObservableTreeSummary; sessions: DshSessionView[] } {
  const eventsBySession = new Map<string, SessionEvent[]>();
  const parents = new Map<string, string>();
  const settlements = new Map<string, { status: string; stopReason: string }>();

  for (const notification of notifications) {
    if (notification.method === 'session.event') {
      const { sessionId, event } = notificationEvent(notification);
      const events = eventsBySession.get(sessionId) ?? [];
      events.push(event);
      eventsBySession.set(sessionId, events);
      continue;
    }
    if (notification.method === 'subagent.started') {
      const parent = requiredString(
        notification.params['parentSessionId'],
        'subagent.started parentSessionId',
      );
      const child = requiredString(
        notification.params['childSessionId'],
        'subagent.started childSessionId',
      );
      const existing = parents.get(child);
      if (existing !== undefined && existing !== parent) {
        warnings.push(`session ${child} was observed with conflicting parents`);
      } else {
        parents.set(child, parent);
      }
      continue;
    }
    if (notification.method === 'subagent.finished') {
      const child = requiredString(
        notification.params['childSessionId'],
        'subagent.finished childSessionId',
      );
      settlements.set(child, {
        status: requiredString(notification.params['status'], 'subagent.finished status'),
        stopReason: requiredString(
          notification.params['stopReason'],
          'subagent.finished stopReason',
        ),
      });
    }
  }

  if (!eventsBySession.has(rootSessionId)) {
    warnings.push('observable tree notifications contained no root session events');
  }
  for (const sessionId of eventsBySession.keys()) {
    if (sessionId !== rootSessionId && !parents.has(sessionId)) {
      warnings.push(`observable session ${sessionId} has no parent lineage edge`);
    }
  }
  for (const [child, parent] of parents) {
    if (!eventsBySession.has(child)) warnings.push(`descendant session ${child} had no observable events`);
    if (parent !== rootSessionId && !eventsBySession.has(parent)) {
      warnings.push(`descendant session ${child} references unobserved parent ${parent}`);
    }
  }
  for (const child of settlements.keys()) {
    if (!parents.has(child)) warnings.push(`finished subagent ${child} had no start lineage edge`);
  }

  const sessionIds = [
    ...(eventsBySession.has(rootSessionId) ? [rootSessionId] : []),
    ...[...eventsBySession.keys()].filter((sessionId) => sessionId !== rootSessionId),
  ];
  const sessions = sessionIds.map((sessionId): DshSessionView => {
    const events = eventsBySession.get(sessionId) ?? [];
    const finishReason = getFinishReason(events);
    const parentSessionId = parents.get(sessionId);
    const subagent = settlements.get(sessionId);
    return {
      sessionId,
      ...summarizeSessionEvents(events, sessionId, warnings),
      finishReason: finishReason ?? 'unknown',
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      ...(subagent === undefined ? {} : { subagent }),
    };
  });

  const tokenUsage = emptyTokenUsage();
  for (const session of sessions) mergeTokenUsage(tokenUsage, session.tokenUsage);
  const tools = sessions.flatMap((session) => session.tools);
  return {
    sessions,
    observableTree: {
      visibility: {
        scope: 'runtime-notifications',
        completeness: 'observable-only',
        limitation: 'Out-of-process subagent internals may be absent.',
      },
      sessionCount: sessions.length,
      steps: sessions.reduce((total, session) => total + session.steps, 0),
      modelCalls: sessions.reduce((total, session) => total + session.modelCalls, 0),
      toolCalls: tools.length,
      tokenUsage,
      tools,
    },
  };
}

/** Build a non-sensitive, stable runtime summary from provider configuration. */
export function summarizeRuntime(config: DshProviderConfig): DshRuntimeSummary {
  return {
    adapterVersion: DSH_ADAPTER_VERSION,
    sdkVersion: DSH_SDK_VERSION,
    profile: config.profile ?? 'sdk',
    patches: (config.patches ?? []).map((patch) => basename(patch)),
    provider: config.provider ?? 'deepseek-official',
    model: config.model ?? 'deepseek-v4-flash',
    ...(config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(config.reasoningEffort) }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
  };
}

/** Create the V1 compact eval view for one successful high-level Run. */
export function projectRunResult(
  result: RunResult,
  config: DshProviderConfig,
): DshEvalMetadataV1 {
  const candidate = result as unknown;
  if (!isRecord(candidate)) {
    throw new DshProjectionError(
      `DSH SDK ${DSH_SDK_VERSION} RunResult contract violation: result must be an object`,
    );
  }
  if (typeof candidate['sessionId'] !== 'string' || candidate['sessionId'].length === 0) {
    throw new DshProjectionError(
      `DSH SDK ${DSH_SDK_VERSION} RunResult contract violation: sessionId must be a non-empty string`,
    );
  }
  if (typeof candidate['finalResponse'] !== 'string') {
    throw new DshProjectionError(
      `DSH SDK ${DSH_SDK_VERSION} RunResult contract violation: finalResponse must be a string`,
    );
  }
  if (!Array.isArray(candidate['events']) || !Array.isArray(candidate['notifications'])) {
    throw new DshProjectionError(
      `DSH SDK ${DSH_SDK_VERSION} RunResult contract violation: events and notifications must be arrays`,
    );
  }
  const warnings: string[] = [];
  const root = summarizeRootEvents(result.events, warnings, result.sessionId);
  const { observableTree, sessions } = projectObservableTree(
    result.notifications,
    result.sessionId,
    warnings,
  );
  return {
    schemaVersion: DSH_EVAL_SCHEMA_VERSION,
    rootSessionId: result.sessionId,
    runtime: summarizeRuntime(config),
    root,
    observableTree,
    sessions,
    warnings,
  };
}

/** Map DSH's disjoint buckets to Promptfoo 0.122.2's supported token fields. */
export function toPromptfooTokenUsage(usage: DshTokenUsage): PromptfooTokenUsage {
  return {
    prompt: usage.uncachedInput + usage.cacheRead + usage.cacheWrite,
    completion: usage.output,
    cached: usage.cacheRead,
    total: usage.total,
    numRequests: usage.requests,
    completionDetails: {
      reasoning: usage.reasoning,
      cacheReadInputTokens: usage.cacheRead,
      cacheCreationInputTokens: usage.cacheWrite,
    },
  };
}
