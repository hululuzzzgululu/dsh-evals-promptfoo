/**
 * Promptfoo extension hooks for DSH evaluation runs.
 *
 * `afterAll` runs once the evaluation finishes and closes every registered
 * DSH harness, reaping each runtime subprocess. The hook is registered with
 * an explicit function name (`file://...:afterAll`) so it runs only for the
 * after-all hook and uses the new calling convention.
 *
 * @module dsh-evals-promptfoo/extension
 */
import { closeAllHarnesses } from './runtime.js';

/** Close every registered DSH harness after the evaluation completes. */
export async function afterAll(): Promise<void> {
  await closeAllHarnesses();
}
