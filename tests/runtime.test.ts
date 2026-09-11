import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { resolve } from 'node:path';
import type { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

import { HarnessController, closeAllHarnesses, toHarnessOptions } from '../src/runtime.js';

const sentinelName = 'DSH_EVAL_PARENT_SENTINEL';
const previousSentinel = process.env[sentinelName];

afterEach(() => {
  if (previousSentinel === undefined) delete process.env[sentinelName];
  else process.env[sentinelName] = previousSentinel;
});

describe('provider Runtime configuration', () => {
  it('maps the complete supported configuration with resolved paths', () => {
    const options = toHarnessOptions({
      basePath: '/config',
      dshBin: 'bin/dsh.mjs',
      profile: 'custom',
      patches: ['a.yml', 'nested/b.yml'],
      dshHome: 'home',
      processCwd: 'runtime',
      cwd: 'workspace',
      provider: 'route',
      model: 'model',
      reasoningEffort: 'high' as never,
      maxTokens: 123,
      initializeTimeoutMs: 10,
      requestTimeoutMs: 20,
      shutdownTimeoutMs: 30,
      disposeEofGraceMs: 40,
      disposeGraceMs: 50,
    });
    assert.deepEqual(options, {
      dshBin: resolve('/config/bin/dsh.mjs'),
      profile: 'custom',
      patches: [resolve('/config/a.yml'), resolve('/config/nested/b.yml')],
      dshHome: resolve('/config/home'),
      processCwd: resolve('/config/runtime'),
      cwd: resolve('/config/workspace'),
      provider: 'route',
      model: 'model',
      reasoningEffort: 'high',
      maxTokens: 123,
      initializeTimeoutMs: 10,
      requestTimeoutMs: 20,
      shutdownTimeoutMs: 30,
      disposeEofGraceMs: 40,
      disposeGraceMs: 50,
    });
  });

  it('merges envOverrides over the inherited environment by default', () => {
    process.env[sentinelName] = 'parent';
    const options = toHarnessOptions({ envOverrides: { DSH_EVAL_OVERRIDE: 'child' } });
    assert.equal(options.env?.[sentinelName], 'parent');
    assert.equal(options.env?.['DSH_EVAL_OVERRIDE'], 'child');
  });

  it('uses only explicit values when inheritEnv is false', () => {
    process.env[sentinelName] = 'parent';
    const options = toHarnessOptions({
      inheritEnv: false,
      envOverrides: { DSH_EVAL_ISOLATED: 'yes' },
    });
    assert.deepEqual(options.env, { DSH_EVAL_ISOLATED: 'yes' });
  });

});

describe('HarnessController cleanup', () => {
  function fakeHarness(close: () => Promise<void>): DeepSeekHarness {
    return { close } as unknown as DeepSeekHarness;
  }

  it('closes every Provider even when one close fails', async () => {
    let successfulCloseCount = 0;
    const failing = new HarnessController({}, () =>
      fakeHarness(async () => {
        throw new Error('synthetic close failure');
      }),
    );
    const successful = new HarnessController({}, () =>
      fakeHarness(async () => {
        successfulCloseCount += 1;
      }),
    );
    await failing.acquire();
    await successful.acquire();
    await assert.rejects(closeAllHarnesses(), /closing DSH harnesses failed/);
    assert.equal(successfulCloseCount, 1);
  });

  it('is idempotent and never reuses a closed Harness', async () => {
    let closeCount = 0;
    const controller = new HarnessController({}, () =>
      fakeHarness(async () => {
        closeCount += 1;
      }),
    );
    await controller.acquire();
    await controller.close();
    await controller.close();
    assert.equal(closeCount, 1);
    await assert.rejects(controller.acquire(), /controller is closed/);
    await closeAllHarnesses();
  });
});
