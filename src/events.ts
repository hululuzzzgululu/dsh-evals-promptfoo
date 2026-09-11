/**
 * Pure projections over a {@link RunResult}'s session events. These are query
 * helpers over the upstream event log, not a second runtime domain model.
 *
 * @module dsh-evals-promptfoo/events
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';

/**
 * Derive the final turn reason of one owned activity interval: the `kind` of
 * the root session's last `turn/end` event.
 *
 * @param events - the interval's `session.event` payloads in wire order.
 * @returns the last turn reason kind, or `undefined` when no turn ended.
 */
export function getFinishReason(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'turn/end') {
      const reason = (event.data as { reason?: { kind?: unknown } }).reason;
      return typeof reason?.kind === 'string' ? reason.kind : undefined;
    }
  }
  return undefined;
}
