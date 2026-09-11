import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  DeepSeekHarnessOptions,
  HarnessNotification,
  RunResult,
} from '@deepseek-ai/dsh-sdk-client';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {
  AssertionValueFunctionContext,
  CallApiOptionsParams,
  ProviderResponse,
} from 'promptfoo';

import {
  assertSupportedVersions,
  installedUpstreamVersions,
  PROMPTFOO_VERSION,
} from '../src/compatibility.js';
import {
  DSH_SDK_VERSION,
  projectRunResult,
  toPromptfooTokenUsage,
} from '../src/projection.js';
import { toHarnessOptions } from '../src/runtime.js';

/** Compile-time reads pin the exact upstream fields used by the adapter. */
function providerFields(response: ProviderResponse): unknown[] {
  return [
    response.output,
    response.error,
    response.sessionId,
    response.finishReason,
    response.tokenUsage,
    response.metadata,
  ];
}

function assertionFields(context: AssertionValueFunctionContext): unknown[] {
  return [context.config, context.provider, context.providerResponse, context.metadata];
}

function abortField(options: CallApiOptionsParams): AbortSignal | undefined {
  return options.abortSignal;
}

describe('locked upstream contracts', () => {
  it('matches the installed SDK and Promptfoo versions', () => {
    assert.deepEqual(installedUpstreamVersions(), {
      dshSdk: DSH_SDK_VERSION,
      promptfoo: PROMPTFOO_VERSION,
    });
    assert.doesNotThrow(() => assertSupportedVersions());
  });

  it('reports expected and actual versions with a repair command', () => {
    assert.throws(
      () => assertSupportedVersions({ dshSdk: '0.0.0', promptfoo: '9.9.9' }),
      (error: unknown) =>
        error instanceof Error &&
        /expected @deepseek-ai\/dsh-sdk-client 0\.1\.5-alpha\.2/.test(error.message) &&
        /found 0\.0\.0 and 9\.9\.9/.test(error.message) &&
        /npm install --save-exact/.test(error.message),
    );
  });

  it('pins the constructor options and excludes superseded direct options', () => {
    const options: DeepSeekHarnessOptions = toHarnessOptions({
      dshBin: 'dsh.mjs',
      profile: 'sdk',
      patches: ['first.yml', 'second.yml'],
      dshHome: 'home',
      processCwd: 'runtime',
      cwd: 'workspace',
      provider: 'route',
      model: 'model',
      reasoningEffort: 'high' as never,
      maxTokens: 100,
    });
    assert.equal('cordis' in options, false);
    assert.equal('sessionRoot' in options, false);
    assert.deepEqual(options.patches?.map((path) => path.split('/').at(-1)), [
      'first.yml',
      'second.yml',
    ]);
  });

  it('pins RunResult, SessionEvent, notification, ProviderResponse, and assertion fields', () => {
    const turnEnd = {
      type: 'turn/end',
      seq: 1,
      time: 0,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent;
    const notification: HarnessNotification = {
      method: 'session.event',
      params: { sessionId: 'root', event: turnEnd },
    };
    const result: RunResult = {
      sessionId: 'root',
      finalResponse: 'answer',
      events: [turnEnd],
      notifications: [notification],
    };
    const metadata = projectRunResult(result, { profile: 'sdk' });
    const response: ProviderResponse = {
      output: result.finalResponse,
      sessionId: result.sessionId,
      finishReason: metadata.root.finishReason,
      tokenUsage: toPromptfooTokenUsage(metadata.observableTree.tokenUsage),
      metadata,
    };
    assert.equal(providerFields(response).length, 6);
    assert.equal(typeof assertionFields, 'function');
    assert.equal(abortField({ abortSignal: new AbortController().signal })?.aborted, false);
  });

  it('fails fast on an incompatible runtime RunResult shape', () => {
    assert.throws(
      () => projectRunResult({ sessionId: 'root' } as RunResult, {}),
      /DSH SDK 0\.1\.5-alpha\.2 RunResult contract violation: finalResponse/,
    );
  });
});
