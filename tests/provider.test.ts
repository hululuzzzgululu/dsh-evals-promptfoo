import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executionAndCleanupError } from '../src/provider.js';

describe('Provider error diagnostics', () => {
  it('preserves execution and cleanup failures in deterministic order', () => {
    assert.equal(
      executionAndCleanupError(new Error('execution failed'), new Error('cleanup failed')),
      'execution failed; Runtime cleanup failed: cleanup failed',
    );
  });

  it('uses the non-sensitive abort diagnosis while retaining cleanup failure', () => {
    assert.equal(
      executionAndCleanupError(new Error('secret execution detail'), 'cleanup failed', true),
      'DSH run aborted; Runtime cleanup failed: cleanup failed',
    );
  });
});
