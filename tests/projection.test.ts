import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client';

import {
  DshProjectionError,
  summarizeRootEvents,
  projectObservableTree,
  summarizeRuntime,
  toPromptfooTokenUsage,
} from '../src/projection.js';

function rawEvent(value: object): SessionEvent {
  return value as SessionEvent;
}

describe('root eval projection', () => {
  it('counts completed steps and every settled model request exactly once', () => {
    const warnings: string[] = [];
    const summary = summarizeRootEvents(
      [
        rawEvent({ type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } }),
        rawEvent({
          type: 'assistant/attempt',
          seq: 2,
          time: 0,
          data: {
            turn: 1,
            step: 1,
            stream: [
              {
                type: 'chunk',
                time: 0,
                chunk: {
                  type: 'usage',
                  usage: { inputTokens: 5, outputTokens: 1, reasoningTokens: 1 },
                },
              },
            ],
          },
        }),
        rawEvent({
          type: 'assistant/message',
          seq: 3,
          time: 0,
          data: {
            turn: 1,
            step: 1,
            message: { id: 'm', role: 'assistant', content: [], source: { kind: 'model' } },
            stream: [
              {
                type: 'chunk',
                time: 0,
                chunk: {
                  type: 'usage',
                  usage: { inputTokens: 999, outputTokens: 999 },
                },
              },
            ],
            usage: {
              inputTokens: 10,
              cacheReadTokens: 2,
              cacheWriteTokens: 3,
              outputTokens: 4,
              reasoningTokens: 2,
            },
          },
        }),
        rawEvent({
          type: 'tool/call',
          seq: 4,
          time: 0,
          data: { turn: 1, step: 1, callId: 'c', name: 'search', arguments: '{}' },
        }),
        rawEvent({
          type: 'turn/end',
          seq: 5,
          time: 0,
          data: { turn: 1, reason: { kind: 'completed' } },
        }),
      ],
      warnings,
    );

    assert.deepEqual(summary, {
      finishReason: 'completed',
      steps: 1,
      modelCalls: 2,
      toolCalls: 1,
      tokenUsage: {
        uncachedInput: 15,
        cacheRead: 2,
        cacheWrite: 3,
        output: 5,
        reasoning: 3,
        total: 25,
        requests: 2,
      },
      tools: [
        {
          sessionId: 'root',
          turn: 1,
          step: 1,
          callId: 'c',
          name: 'search',
          rawArguments: '{}',
          parsedArguments: {},
          status: 'unpaired',
        },
      ],
    });
    assert.deepEqual(warnings, []);
  });

  it('counts a request without usage and records a warning', () => {
    const warnings: string[] = [];
    const summary = summarizeRootEvents(
      [
        rawEvent({
          type: 'assistant/attempt',
          seq: 2,
          time: 0,
          data: { turn: 1, step: 1, stream: [] },
        }),
        rawEvent({
          type: 'turn/end',
          seq: 3,
          time: 0,
          data: { turn: 1, reason: { kind: 'error' } },
        }),
      ],
      warnings,
    );
    assert.equal(summary.modelCalls, 1);
    assert.equal(summary.tokenUsage.requests, 1);
    assert.equal(warnings.length, 1);
  });

  it('rejects a successful SDK result without a valid final reason', () => {
    assert.throws(
      () => summarizeRootEvents([]),
      (error: unknown) =>
        error instanceof DshProjectionError && /turn\/end reason/.test(error.message),
    );
  });

  it('maps disjoint DSH token buckets without adding reasoning twice', () => {
    assert.deepEqual(
      toPromptfooTokenUsage({
        uncachedInput: 10,
        cacheRead: 2,
        cacheWrite: 3,
        output: 4,
        reasoning: 1,
        total: 19,
        requests: 2,
      }),
      {
        prompt: 15,
        completion: 4,
        cached: 2,
        total: 19,
        numRequests: 2,
        completionDetails: {
          reasoning: 1,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 3,
        },
      },
    );
  });

  it('keeps only non-sensitive runtime identity', () => {
    assert.deepEqual(
      summarizeRuntime({
        dshBin: '/secret/home/dsh',
        dshHome: '/secret/home',
        envOverrides: { API_KEY: 'secret' },
        profile: 'sdk',
        patches: ['/private/config/first.yml', '../second.yml'],
        provider: 'route',
        model: 'model',
        maxTokens: 123,
      } as never),
      {
        adapterVersion: '0.1.0',
        sdkVersion: '0.1.5-alpha.2',
        profile: 'sdk',
        patches: ['first.yml', 'second.yml'],
        provider: 'route',
        model: 'model',
        maxTokens: 123,
      },
    );
  });

});

describe('observable Agent tree projection', () => {
  function eventNotification(sessionId: string, event: object): HarnessNotification {
    return { method: 'session.event', params: { sessionId, event } };
  }

  function toolEvents(sessionId: string, name: string): HarnessNotification[] {
    return [
      eventNotification(sessionId, {
        type: 'tool/call',
        seq: 1,
        time: 0,
        data: { turn: 1, step: 1, callId: 'same-id', name, arguments: '{}' },
      }),
      eventNotification(sessionId, {
        type: 'tool/result',
        seq: 2,
        time: 0,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: `result-${sessionId}`,
            role: 'user',
            content: [
              { type: 'tool-result', toolCallId: 'same-id', content: [{ type: 'text', text: 'ok' }] },
            ],
            source: { kind: 'tool', callId: 'same-id' },
          },
        },
      }),
      eventNotification(sessionId, {
        type: 'turn/end',
        seq: 3,
        time: 0,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ];
  }

  it('keeps lineage and scopes colliding call ids by Session', () => {
    const warnings: string[] = [];
    const notifications: HarnessNotification[] = [
      ...toolEvents('root', 'root_tool'),
      { method: 'subagent.started', params: { parentSessionId: 'root', childSessionId: 'a' } },
      { method: 'subagent.started', params: { parentSessionId: 'root', childSessionId: 'b' } },
      ...toolEvents('a', 'alpha'),
      ...toolEvents('b', 'beta'),
      {
        method: 'subagent.finished',
        params: { childSessionId: 'a', status: 'ok', stopReason: 'completed' },
      },
      {
        method: 'subagent.finished',
        params: { childSessionId: 'b', status: 'ok', stopReason: 'completed' },
      },
    ];
    const projected = projectObservableTree(notifications, 'root', warnings);
    assert.equal(projected.observableTree.sessionCount, 3);
    assert.equal(projected.observableTree.toolCalls, 3);
    assert.deepEqual(
      projected.observableTree.tools.map((tool) => [tool.sessionId, tool.callId, tool.status]),
      [
        ['root', 'same-id', 'succeeded'],
        ['a', 'same-id', 'succeeded'],
        ['b', 'same-id', 'succeeded'],
      ],
    );
    assert.equal(projected.sessions.find((session) => session.sessionId === 'a')?.parentSessionId, 'root');
    assert.deepEqual(warnings, []);
    assert.equal(projected.observableTree.visibility.completeness, 'observable-only');
  });

  it('warns about observable lineage gaps instead of assuming completeness', () => {
    const warnings: string[] = [];
    projectObservableTree(toolEvents('orphan', 'tool'), 'root', warnings);
    assert.equal(warnings.some((warning) => /no root session events/.test(warning)), true);
    assert.equal(warnings.some((warning) => /no parent lineage/.test(warning)), true);
  });
});
