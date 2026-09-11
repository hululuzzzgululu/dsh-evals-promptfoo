import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateExecutionHealth } from '../src/assertions.js';
import type { DshEvalMetadataV1, DshSessionView, DshToolCallView } from '../src/projection.js';

function metadata(options: {
  reason?: string;
  tools?: DshToolCallView[];
  sessions?: DshSessionView[];
} = {}): DshEvalMetadataV1 {
  const tools = options.tools ?? [];
  const root = {
    finishReason: options.reason ?? 'completed',
    steps: 1,
    modelCalls: 1,
    toolCalls: tools.length,
    tokenUsage: {
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      requests: 1,
    },
    tools,
  };
  return {
    schemaVersion: 1,
    rootSessionId: 'root',
    runtime: {
      adapterVersion: '0.1.0',
      sdkVersion: '0.1.5-alpha.2',
      profile: 'sdk',
      patches: [],
      provider: 'fake',
      model: 'fake',
    },
    root,
    observableTree: {
      visibility: {
        scope: 'runtime-notifications',
        completeness: 'observable-only',
        limitation: 'test',
      },
      sessionCount: 1 + (options.sessions?.length ?? 0),
      steps: 1,
      modelCalls: 1,
      toolCalls: tools.length,
      tokenUsage: root.tokenUsage,
      tools,
    },
    sessions: options.sessions ?? [],
    warnings: [],
  };
}

function tool(name: string, status: DshToolCallView['status']): DshToolCallView {
  return {
    sessionId: 'root',
    turn: 1,
    step: 1,
    callId: name,
    name,
    rawArguments: '{}',
    parsedArguments: {},
    status,
  };
}

function failedChild(): DshSessionView {
  return {
    sessionId: 'child',
    parentSessionId: 'root',
    finishReason: 'error',
    steps: 1,
    modelCalls: 1,
    toolCalls: 0,
    tokenUsage: {
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      requests: 1,
    },
    tools: [],
    subagent: { status: 'error', stopReason: 'error' },
  };
}

describe('DSH execution health', () => {
  it('passes a completed healthy tree', () => {
    const result = evaluateExecutionHealth(metadata());
    assert.equal(result.pass, true);
    assert.equal(result.score, 1);
    assert.equal(result.componentResults?.length, 4);
  });

  for (const reason of ['error', 'max-tokens', 'blocked', 'aborted', 'interrupted']) {
    it(`fails root termination reason ${reason}`, () => {
      const result = evaluateExecutionHealth(metadata({ reason }));
      assert.equal(result.pass, false);
      assert.equal(result.namedScores?.['dsh.health.rootCompleted'], 0);
    });
  }

  it('fails unpaired calls, Tool errors, and failed Subagents independently', () => {
    const result = evaluateExecutionHealth(
      metadata({ tools: [tool('pending', 'unpaired'), tool('danger', 'error')], sessions: [failedChild()] }),
    );
    assert.equal(result.pass, false);
    assert.equal(result.score, 1 / 4);
    assert.equal(result.namedScores?.['dsh.health.pairedTools'], 0);
    assert.equal(result.namedScores?.['dsh.health.toolErrors'], 0);
    assert.equal(result.namedScores?.['dsh.health.subagents'], 0);
  });

  it('allows only explicitly declared Tool and Subagent failures', () => {
    const result = evaluateExecutionHealth(
      metadata({ tools: [tool('danger', 'error')], sessions: [failedChild()] }),
      {
        allowToolErrors: ['danger'],
        allowSubagentFailures: [{ stopReason: 'error' }],
      },
    );
    assert.equal(result.pass, true);
  });
});
