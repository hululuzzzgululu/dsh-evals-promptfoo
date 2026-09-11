import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunResult } from '@deepseek-ai/dsh-sdk-client';

import type {
  DshEvalMetadataV1,
  DshExecutionSummary,
  DshToolCallView,
} from '../src/projection.js';
import { protectEvalMetadata } from '../src/security.js';

function tool(index: number): DshToolCallView {
  const secret = 'sk-unit-secret-1234567890';
  const parsedArguments = {
    index,
    API_KEY: secret,
    nested: [{ PaSsWoRd: `password-${index}`, safe: 'visible' }],
    credential: secret,
    long: 'x'.repeat(200),
  };
  return {
    sessionId: 'root',
    turn: 1,
    step: 1,
    callId: `call-${index}`,
    name: `tool-${index}`,
    rawArguments: JSON.stringify(parsedArguments),
    parsedArguments,
    status: index === 0 ? 'error' : 'succeeded',
    result: { blockCount: 3, contentTypes: ['text', 'image', 'audio'] },
    ...(index === 0 ? { error: { name: `Failure ${secret}`, code: secret } } : {}),
  };
}

function summary(tools: DshToolCallView[]): DshExecutionSummary {
  return {
    finishReason: 'completed',
    steps: 1,
    modelCalls: 1,
    toolCalls: tools.length,
    tokenUsage: {
      uncachedInput: 1,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1,
      reasoning: 0,
      total: 2,
      requests: 1,
    },
    tools,
  };
}

function metadata(): DshEvalMetadataV1 {
  const tools = [tool(0), tool(1), tool(2)];
  return {
    schemaVersion: 1,
    rootSessionId: 'root',
    runtime: {
      adapterVersion: '0.1.0',
      sdkVersion: '0.1.5-alpha.2',
      profile: 'sdk',
      patches: ['one', 'two', 'three'],
      provider: 'route',
      model: 'model',
    },
    root: summary(tools),
    observableTree: {
      visibility: {
        scope: 'runtime-notifications',
        completeness: 'observable-only',
        limitation: 'L'.repeat(200),
      },
      sessionCount: 3,
      steps: 3,
      modelCalls: 3,
      toolCalls: 3,
      tokenUsage: summary([]).tokenUsage,
      tools,
    },
    sessions: [0, 1, 2].map((index) => ({
      sessionId: `session-${index}`,
      ...summary([tool(index)]),
    })),
    warnings: [
      'Bearer unit-bearer-secret',
      'second warning',
      'third warning',
    ],
  };
}

const emptyResult = {
  sessionId: 'root',
  finalResponse: 'unchanged output',
  events: [],
  notifications: [],
} as RunResult;

describe('persisted eval data policy', () => {
  it('recursively redacts and bounds metadata while retaining aggregate facts', () => {
    const safe = protectEvalMetadata(metadata(), emptyResult, {
      maxStringLength: 32,
      maxToolCalls: 1,
      maxSessions: 1,
      maxWarnings: 20,
      maxSummaryItems: 1,
      additionalSecretKeys: ['credential'],
      additionalSecretPaths: ['root.tools.*.parsedArguments.nested.*.safe'],
    });
    const serialized = JSON.stringify(safe);

    assert.equal(safe.root.toolCalls, 3, 'aggregate count stays complete');
    assert.equal(safe.observableTree.sessionCount, 3, 'aggregate count stays complete');
    assert.equal(safe.root.tools.length, 1);
    assert.equal(safe.observableTree.tools.length, 1);
    assert.equal(safe.sessions.length, 1);
    assert.equal(safe.sessions[0]?.tools.length, 1);
    assert.deepEqual(safe.runtime.patches, ['one']);
    assert.deepEqual(safe.root.tools[0]?.result?.contentTypes, ['text']);
    assert.equal(
      (safe.root.tools[0]?.parsedArguments as { API_KEY?: string }).API_KEY,
      '[REDACTED]',
    );
    assert.equal(
      (safe.root.tools[0]?.parsedArguments as { nested?: Array<{ PaSsWoRd?: string; safe?: string }> })
        .nested?.[0]?.PaSsWoRd,
      '[REDACTED]',
    );
    assert.equal(
      (safe.root.tools[0]?.parsedArguments as { nested?: Array<{ safe?: string }> }).nested?.[0]
        ?.safe,
      '[REDACTED]',
    );
    assert.equal(safe.rawEvents, undefined);
    assert.doesNotMatch(serialized, /sk-unit-secret|password-0|unit-bearer-secret/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.equal(
      ((safe.root.tools[0]?.parsedArguments as { long?: string }).long?.length ?? 0) <= 32,
      true,
    );
    assert.equal(safe.warnings.some((warning) => /omitted/.test(warning)), true);
    assert.equal(safe.warnings.some((warning) => /maxStringLength/.test(warning)), true);
  });

  it('includes unredacted wire data only with an explicit unsafe option and warning', () => {
    const secret = 'sk-raw-secret-1234567890';
    const result = {
      ...emptyResult,
      events: [{ type: 'synthetic', prompt: secret }],
    } as unknown as RunResult;
    const safe = protectEvalMetadata(metadata(), result, { rawEvents: true });
    assert.equal(JSON.stringify(safe.rawEvents).includes(secret), true);
    assert.equal(safe.warnings.some((warning) => /rawEvents is enabled/.test(warning)), true);
  });

  it('rejects invalid limits before persisting a partial view', () => {
    assert.throws(
      () => protectEvalMetadata(metadata(), emptyResult, { maxStringLength: 8 }),
      /maxStringLength/,
    );
    assert.throws(
      () => protectEvalMetadata(metadata(), emptyResult, { maxWarnings: 0 }),
      /maxWarnings/,
    );
  });
});
