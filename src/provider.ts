/**
 * Promptfoo provider that evaluates one complete DeepSeek Harness agent run.
 *
 * Each `callApi` sends the promptfoo-rendered prompt text to a lazily
 * started, case-reusable DSH runtime and maps the SDK's owned activity
 * interval onto a promptfoo `ProviderResponse`. The adapter stays thin: the
 * final response becomes `output`, the session id and derived finish reason
 * land in the native fields, and infrastructure failures become `error`.
 *
 * @module dsh-evals-promptfoo/provider
 */
import type { CallApiContextParams, CallApiOptionsParams, ProviderResponse } from 'promptfoo';
import type { DeepSeekHarness, RunResult } from '@deepseek-ai/dsh-sdk-client';

import { projectRunResult, toPromptfooTokenUsage } from './projection.js';
import type { DshEvalMetadataV1 } from './projection.js';
import { protectEvalMetadata } from './security.js';
import { assertSupportedVersions } from './compatibility.js';
import { loadCandidateConfig, type CandidateProviderConfig } from './candidate.js';
import { HarnessController, toHarnessOptions, type DshProviderConfig } from './runtime.js';

/** The options object promptfoo constructs custom providers with. */
export interface ProviderOptions {
  id?: string;
  label?: string;
  config?: CandidateProviderConfig;
}

export default class DshProvider {
  private readonly providerId: string;
  private readonly harnessController: HarnessController;
  private readonly config: DshProviderConfig;
  private readonly assertionViews = new Map<string, DshEvalMetadataV1>();

  constructor(options: ProviderOptions = {}) {
    assertSupportedVersions();
    this.providerId = options.label ?? options.id ?? 'dsh';
    if (options.config === undefined) {
      throw new TypeError('DSH provider requires config.candidateConfig');
    }
    this.config = loadCandidateConfig(options.config);
    this.harnessController = new HarnessController(toHarnessOptions(this.config));
  }

  id(): string {
    return this.providerId;
  }

  /** Full in-memory view for same-process assertions; never returned to Promptfoo. */
  dshAssertionMetadata(sessionId: string): DshEvalMetadataV1 | undefined {
    return this.assertionViews.get(sessionId);
  }

  /**
   * Run one prompt on a fresh session of this provider's harness.
   *
   * @param prompt - the promptfoo-rendered prompt text (V1 accepts text only).
   * @returns the activity interval as a provider response; transport,
   * protocol, and timeout failures return `error` instead of output.
   */
  async callApi(
    prompt: string,
    _context?: CallApiContextParams,
    options?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    const signal = options?.abortSignal;
    const isAborted = () => signal?.aborted === true;
    if (isAborted()) {
      try {
        await this.harnessController.invalidateCurrent();
        return { error: 'DSH run aborted before start; Runtime was closed and reaped' };
      } catch (error) {
        return { error: `DSH run aborted and Runtime cleanup failed: ${errorMessage(error)}` };
      }
    }

    let harness: DeepSeekHarness | undefined;
    try {
      harness = await this.harnessController.acquire();
      const activeHarness = harness;
      let abortTask: Promise<void> | undefined;
      const onAbort = () => {
        abortTask ??= this.harnessController.invalidateAndClose(activeHarness);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      let result: RunResult;
      try {
        result = await activeHarness.run(prompt);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      if (isAborted()) {
        abortTask ??= this.harnessController.invalidateAndClose(activeHarness);
        await abortTask;
        return { error: 'DSH run aborted; Runtime was closed and reaped' };
      }
      const assertionMetadata = projectRunResult(result, this.config);
      this.assertionViews.set(result.sessionId, assertionMetadata);
      const metadata = protectEvalMetadata(assertionMetadata, result, this.config.evalData);
      return {
        output: result.finalResponse,
        sessionId: result.sessionId,
        finishReason: assertionMetadata.root.finishReason,
        tokenUsage: toPromptfooTokenUsage(assertionMetadata.observableTree.tokenUsage),
        metadata,
      };
    } catch (error) {
      const aborted = isAborted();
      try {
        if (harness === undefined) await this.harnessController.invalidateCurrent();
        else await this.harnessController.invalidateAndClose(harness);
      } catch (cleanupError) {
        return {
          error: executionAndCleanupError(error, cleanupError, aborted),
        };
      }
      return {
        error: aborted
          ? 'DSH run aborted; Runtime was closed and reaped'
          : errorMessage(error),
      };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Preserve both causes when execution and mandatory Runtime cleanup fail. */
export function executionAndCleanupError(
  executionError: unknown,
  cleanupError: unknown,
  aborted = false,
): string {
  return `${aborted ? 'DSH run aborted' : errorMessage(executionError)}; Runtime cleanup failed: ${errorMessage(cleanupError)}`;
}
