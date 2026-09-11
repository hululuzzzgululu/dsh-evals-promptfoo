import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateToolBehavior, isJsonSubset } from '../src/assertions.js';
import type { DshToolCallView } from '../src/projection.js';

function call(
  name: string,
  parsedArguments: unknown,
  overrides: Partial<DshToolCallView> = {},
): DshToolCallView {
  return {
    sessionId: 'root',
    turn: 1,
    step: 1,
    callId: `${name}-id`,
    name,
    rawArguments: JSON.stringify(parsedArguments),
    parsedArguments,
    status: 'succeeded',
    ...overrides,
  };
}

describe('DSH Tool behavior assertion', () => {
  const calls = [
    call('search', { query: 'hello', filters: { fresh: true }, tags: ['a', 'b'] }),
    call('noise', {}),
    call('read', { path: '/tmp/result' }),
  ];

  it('passes a unified allowlist/required/forbidden/count/argument/sequence assertion', () => {
    const result = evaluateToolBehavior(calls, {
      allowed: ['search', 'noise', 'read'],
      required: ['search'],
      forbidden: ['write'],
      maximumCalls: { search: 1 },
      arguments: [{ name: 'search', contains: { filters: { fresh: true } } }],
      sequence: ['search', 'read'],
    });
    assert.equal(result.pass, true);
    assert.equal(result.score, 1);
    assert.equal(result.componentResults?.length, 6);
    assert.equal(Object.keys(result.namedScores ?? {}).length, 6);
  });

  it('fails an allowlist when an unexpected Tool is observed', () => {
    const result = evaluateToolBehavior(calls, { allowed: ['search', 'read'] });

    assert.equal(result.pass, false);
    assert.equal(result.namedScores?.['dsh.tool.root.allowed'], 0);
    assert.match(result.reason, /1 of 1/);
    assert.match(result.componentResults?.[0]?.reason ?? '', /noise/);
  });

  it('rejects an allowlist that is not an array of Tool names', () => {
    assert.throws(
      () => evaluateToolBehavior(calls, { allowed: 'read' } as never),
      /allowed must be an array of tool names/,
    );
  });

  it('reports every failed component and scores by passed proportion', () => {
    const result = evaluateToolBehavior(calls, {
      required: ['missing'],
      forbidden: ['search'],
      maximumCalls: { search: 0 },
      arguments: [{ name: 'search', contains: { query: 'different' } }],
      sequence: ['read', 'search'],
    });
    assert.equal(result.pass, false);
    assert.equal(result.score, 0);
    assert.equal(result.componentResults?.every((component) => !component.pass), true);
  });

  it('keeps selection/count evaluable when raw arguments are invalid', () => {
    const invalid = call('search', undefined, {
      rawArguments: '{nope',
      parsedArguments: undefined,
      argumentParseError: 'invalid JSON',
    });
    const result = evaluateToolBehavior([invalid], {
      required: ['search'],
      maximumCalls: { search: 1 },
      arguments: [{ name: 'search', contains: { query: 'hello' } }],
    });
    assert.equal(result.pass, false);
    assert.equal(result.score, 2 / 3);
    assert.match(result.componentResults?.[2]?.reason ?? '', /invalid JSON/);
  });

  it('uses recursive object subsets but exact primitives and arrays', () => {
    assert.equal(isJsonSubset({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 1 } }), true);
    assert.equal(isJsonSubset({ list: [1, 2, 3] }, { list: [1, 2] }), false);
    assert.equal(isJsonSubset({ enabled: 1 }, { enabled: true }), false);
  });

  it('rejects a non-object contains condition', () => {
    assert.throws(
      () =>
        evaluateToolBehavior(calls, {
          arguments: [{ name: 'search', contains: [] as never }],
        }),
      /object contains value/,
    );
  });

  it('does not form a tree sequence across parallel Sessions', () => {
    const result = evaluateToolBehavior(
      [
        call('alpha', {}, { sessionId: 'child-a' }),
        call('beta', {}, { sessionId: 'child-b' }),
      ],
      { scope: 'tree', sequence: ['alpha', 'beta'] },
    );
    assert.equal(result.pass, false);
    assert.equal(result.namedScores?.['dsh.tool.tree.sequence'], 0);
  });
});
