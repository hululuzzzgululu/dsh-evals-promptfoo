/**
 * Example Promptfoo hooks for caller-owned workspace isolation.
 *
 * These hooks deliberately live outside the provider: fresh DSH Sessions do
 * not reset files, plugin singletons, databases, or external services. A real
 * evaluation should replace this marker-file reset with its own reset/seed
 * logic and let failures propagate so evaluation never continues from an
 * unknown state.
 *
 * @module dsh-evals-promptfoo/state-reset
 */
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  AfterEachExtensionHookContext,
  BeforeEachExtensionHookContext,
} from 'promptfoo';

/** Example marker for caller-owned state reset hooks. */
export function stateFilePath(): string {
  return process.env['DSH_EVAL_STATE_FILE'] ?? resolve('tmp/dsh-eval-state-marker');
}

/** Reset caller-owned state, surfacing filesystem errors to Promptfoo. */
export async function resetWorkspaceState(): Promise<void> {
  const stateFile = stateFilePath();
  await mkdir(dirname(stateFile), { recursive: true });
  await rm(stateFile, { force: true });
}

/** Establish a clean boundary before every test case. */
export async function beforeEach(
  context: BeforeEachExtensionHookContext,
): Promise<BeforeEachExtensionHookContext> {
  await resetWorkspaceState();
  return context;
}

/** Remove caller-owned state after every test case, including failed cases. */
export async function afterEach(
  context: AfterEachExtensionHookContext,
): Promise<AfterEachExtensionHookContext> {
  await resetWorkspaceState();
  return context;
}
