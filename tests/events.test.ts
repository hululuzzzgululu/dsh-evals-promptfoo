import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getFinishReason } from '../src/events.js';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

/**
 * Cast one raw wire-shaped event to {@link SessionEvent}. Sequence numbers are
 * branded on the TypeScript side but plain JSON on the wire; the SDK client
 * applies the same view when it validates `session.event` payloads.
 */
function rawEvent(value: object): SessionEvent {
  return value as SessionEvent;
}

describe('getFinishReason', () => {
  it('returns the kind of the last turn/end event', () => {
    const events = [
      rawEvent({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }),
      rawEvent({ type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'error' } } }),
      rawEvent({ type: 'turn/start', seq: 2, time: 0, data: { turn: 2 } }),
      rawEvent({ type: 'turn/end', seq: 3, time: 0, data: { turn: 2, reason: { kind: 'completed' } } }),
    ];
    assert.equal(getFinishReason(events), 'completed');
  });

  it('returns the only turn/end kind when the interval has a single turn', () => {
    const events = [
      rawEvent({ type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'max-tokens' } } }),
    ];
    assert.equal(getFinishReason(events), 'max-tokens');
  });

  it('returns undefined when the interval has no turn/end event', () => {
    const events = [rawEvent({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })];
    assert.equal(getFinishReason(events), undefined);
  });

  it('returns undefined for an empty interval', () => {
    assert.equal(getFinishReason([]), undefined);
  });
});
