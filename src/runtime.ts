/**
 * DSH harness lifecycle for promptfoo providers.
 *
 * Each provider instance owns one lazily-created harness that is reused
 * across test cases. A process-wide registry closes every owned runtime.
 *
 * @module dsh-evals-promptfoo/runtime
 */
import { resolve } from 'node:path';

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client';
import type { DshEvalDataPolicy } from './security.js';

/**
 * Provider configuration. Filesystem paths resolve against `basePath`, which
 * promptfoo supplies as the directory containing its config file.
 */
export interface DshProviderConfig {
  /** Caller-relative dsh CLI module; omitted resolves the SDK's same-version dsh. */
  dshBin?: string;
  /** Named profile serving the SDK protocol (default `sdk`). */
  profile?: string;
  /** Ordered per-launch profile patches, applied in array order. */
  patches?: string[];
  /** Explicit Harness home for this child. */
  dshHome?: string;
  /** Working directory for the runtime process itself. */
  processCwd?: string;
  /** Workspace cwd recorded on each fresh Session. */
  cwd?: string;
  /** Provider route used by each fresh Session. */
  provider?: string;
  /** Model route used by each fresh Session. */
  model?: string;
  /** Adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: DeepSeekHarnessOptions['reasoningEffort'];
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number;
  /** Bound (ms) on the initial profile handshake (default 10000). */
  initializeTimeoutMs?: number;
  /** Per-request timeout (ms); omitted waits indefinitely. */
  requestTimeoutMs?: number;
  /** Bound (ms) on the protocol shutdown exchange. */
  shutdownTimeoutMs?: number;
  /** Grace (ms) for stdin-EOF shutdown before signals. */
  disposeEofGraceMs?: number;
  /** Termination confirmation window (ms) for signals. */
  disposeGraceMs?: number;
  /** Incremental child environment overrides. Values never enter eval metadata. */
  envOverrides?: NodeJS.ProcessEnv;
  /** Whether envOverrides apply over the parent environment (default true). */
  inheritEnv?: boolean;
  /** Bounds, redaction, and opt-in raw-event policy for persisted eval metadata. */
  evalData?: DshEvalDataPolicy;
  /** Promptfoo injects the config directory here. */
  basePath?: string;
}

/** Resolve one config path against the config's base directory. */
function resolvePath(basePath: string | undefined, path: string): string {
  return resolve(basePath ?? process.cwd(), path);
}

/** Translate provider config into SDK harness options with absolute paths. */
export function toHarnessOptions(config: DshProviderConfig): DeepSeekHarnessOptions {
  const options: DeepSeekHarnessOptions = {};
  if (config.dshBin !== undefined) options.dshBin = resolvePath(config.basePath, config.dshBin);
  if (config.profile !== undefined) options.profile = config.profile;
  if (config.patches !== undefined) {
    options.patches = config.patches.map((patch) => resolvePath(config.basePath, patch));
  }
  if (config.dshHome !== undefined) options.dshHome = resolvePath(config.basePath, config.dshHome);
  if (config.processCwd !== undefined) options.processCwd = resolvePath(config.basePath, config.processCwd);
  if (config.cwd !== undefined) options.cwd = resolvePath(config.basePath, config.cwd);
  if (config.provider !== undefined) options.provider = config.provider;
  if (config.model !== undefined) options.model = config.model;
  if (config.reasoningEffort !== undefined) options.reasoningEffort = config.reasoningEffort;
  if (config.maxTokens !== undefined) options.maxTokens = config.maxTokens;
  if (config.initializeTimeoutMs !== undefined) options.initializeTimeoutMs = config.initializeTimeoutMs;
  if (config.requestTimeoutMs !== undefined) options.requestTimeoutMs = config.requestTimeoutMs;
  if (config.shutdownTimeoutMs !== undefined) options.shutdownTimeoutMs = config.shutdownTimeoutMs;
  if (config.disposeEofGraceMs !== undefined) options.disposeEofGraceMs = config.disposeEofGraceMs;
  if (config.disposeGraceMs !== undefined) options.disposeGraceMs = config.disposeGraceMs;
  if (config.envOverrides !== undefined || config.inheritEnv === false) {
    options.env = {
      ...(config.inheritEnv === false ? {} : process.env),
      ...(config.envOverrides ?? {}),
    };
  }
  return options;
}

/** Process-wide registry owns controllers, never a shared harness instance. */
const registry = new Set<HarnessController>();

/**
 * One Provider's serial Runtime lifecycle. Invalidation removes the current
 * harness synchronously, while acquire waits for confirmed cleanup before
 * constructing its replacement.
 */
export class HarnessController {
  private current: DeepSeekHarness | undefined;
  private readonly closeTasks = new Map<DeepSeekHarness, Promise<void>>();
  private readonly closing = new Set<Promise<void>>();
  private closeFailure: unknown;
  private terminal = false;

  constructor(
    private readonly options: DeepSeekHarnessOptions,
    private readonly createHarness: (options: DeepSeekHarnessOptions) => DeepSeekHarness = (
      harnessOptions,
    ) => new DeepSeekHarness(harnessOptions),
  ) {
    registry.add(this);
  }

  /** Acquire the reusable harness, waiting for every invalidated harness to close. */
  async acquire(): Promise<DeepSeekHarness> {
    await Promise.all([...this.closing]);
    if (this.closeFailure !== undefined) {
      throw new AggregateError([this.closeFailure], 'previous DSH Runtime cleanup failed');
    }
    if (this.terminal) throw new Error('DSH harness controller is closed');
    this.current ??= this.createHarness(this.options);
    return this.current;
  }

  /** Invalidate one generation and wait until its owned cleanup is confirmed. */
  invalidateAndClose(harness: DeepSeekHarness): Promise<void> {
    if (this.current === harness) this.current = undefined;
    return this.closeHarness(harness);
  }

  /** Invalidate the current generation, if one exists. */
  async invalidateCurrent(): Promise<void> {
    const harness = this.current;
    if (harness !== undefined) await this.invalidateAndClose(harness);
  }

  private closeHarness(harness: DeepSeekHarness): Promise<void> {
    const existing = this.closeTasks.get(harness);
    if (existing !== undefined) return existing;

    let tracked!: Promise<void>;
    tracked = harness
      .close()
      .catch((error: unknown) => {
        this.closeFailure ??= error;
        throw error;
      })
      .finally(() => {
        this.closing.delete(tracked);
      });
    this.closeTasks.set(harness, tracked);
    this.closing.add(tracked);
    return tracked;
  }

  /** Terminal, idempotent close used by the process-wide after-all hook. */
  async close(): Promise<void> {
    this.terminal = true;
    const current = this.current;
    this.current = undefined;
    if (current !== undefined) this.closeHarness(current).catch(() => undefined);
    const settlements = await Promise.allSettled([...this.closeTasks.values()]);
    const errors = settlements
      .filter((settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected')
      .map((settlement) => settlement.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'closing Provider DSH Runtime failed');
  }
}

/**
 * Close every registered harness and reap its runtime subprocess. Each
 * harness closes independently, so one failed teardown cannot block the
 * others; if any teardown failed, an aggregate error is thrown after every
 * close settled. Safe to call when nothing is registered.
 *
 * @returns settlement of all teardowns.
 */
export async function closeAllHarnesses(): Promise<void> {
  const controllers = [...registry];
  registry.clear();
  const settlements = await Promise.allSettled(
    controllers.map((controller) => controller.close()),
  );
  const errors = settlements
    .filter((settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected')
    .map((settlement) => settlement.reason);
  if (errors.length > 0) throw new AggregateError(errors, 'closing DSH harnesses failed');
}

let sigintCleanupTask: Promise<void> | undefined;

/** A first SIGINT starts one bounded close-all task; repeats reuse that task. */
function handleSigint(): void {
  sigintCleanupTask ??= closeAllHarnesses().catch((error: unknown) => {
    process.stderr.write(`DSH Runtime cleanup after SIGINT failed: ${String(error)}\n`);
  });
}

process.on('SIGINT', handleSigint);
