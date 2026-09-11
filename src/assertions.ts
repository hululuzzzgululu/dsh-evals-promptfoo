/** Promptfoo JavaScript assertions over the versioned DSH eval view. */
import type { AssertionValueFunctionContext, GradingResult } from 'promptfoo';

import {
  DSH_EVAL_SCHEMA_VERSION,
  ROOT_METRIC_NAMES,
  TREE_METRIC_NAMES,
  type DshEvalMetadataV1,
  type DshToolCallView,
} from './projection.js';

function metadataFrom(context: AssertionValueFunctionContext): DshEvalMetadataV1 {
  const provider = context.provider as
    | { dshAssertionMetadata?: (sessionId: string) => DshEvalMetadataV1 | undefined }
    | undefined;
  const sessionId = context.providerResponse?.sessionId;
  const assertionMetadata =
    typeof sessionId === 'string' ? provider?.dshAssertionMetadata?.(sessionId) : undefined;
  if (assertionMetadata?.schemaVersion === DSH_EVAL_SCHEMA_VERSION) return assertionMetadata;
  const metadata = context.metadata;
  if (metadata?.['schemaVersion'] !== DSH_EVAL_SCHEMA_VERSION) {
    throw new Error(`expected DSH eval metadata schema version ${DSH_EVAL_SCHEMA_VERSION}`);
  }
  return metadata as DshEvalMetadataV1;
}

/**
 * Publish root execution observations as named Promptfoo metrics without
 * grading the answer (native assertions continue to own answer quality).
 */
export function rootMetrics(
  _output: string,
  context: AssertionValueFunctionContext,
): GradingResult {
  const { root } = metadataFrom(context);
  return {
    pass: true,
    score: 1,
    reason: 'Published DSH root execution metrics',
    namedScores: {
      [ROOT_METRIC_NAMES.steps]: root.steps,
      [ROOT_METRIC_NAMES.modelCalls]: root.modelCalls,
      [ROOT_METRIC_NAMES.toolCalls]: root.toolCalls,
      [TREE_METRIC_NAMES.sessions]: metadataFrom(context).observableTree.sessionCount,
      [TREE_METRIC_NAMES.steps]: metadataFrom(context).observableTree.steps,
      [TREE_METRIC_NAMES.modelCalls]: metadataFrom(context).observableTree.modelCalls,
      [TREE_METRIC_NAMES.toolCalls]: metadataFrom(context).observableTree.toolCalls,
    },
  };
}

type JsonObject = Record<string, unknown>;

export interface ToolBehaviorConfig {
  scope?: 'root' | 'tree';
  /** When present, every observed Tool must be in this allowlist. */
  allowed?: string[];
  required?: string[];
  forbidden?: string[];
  maximumCalls?: Record<string, number>;
  arguments?: Array<{ name: string; contains: JsonObject }>;
  sequence?: string[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => jsonEqual(value, expected[index]))
    );
  }
  if (isObject(expected)) {
    return (
      isObject(actual) &&
      Object.keys(actual).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => jsonEqual(actual[key], value))
    );
  }
  return Object.is(actual, expected);
}

/** Object-recursive subset; arrays and primitives require exact equality. */
export function isJsonSubset(actual: unknown, expected: JsonObject): boolean {
  if (!isObject(actual)) return false;
  return Object.entries(expected).every(([key, value]) => {
    const actualValue = actual[key];
    return isObject(value) ? isJsonSubset(actualValue, value) : jsonEqual(actualValue, value);
  });
}

function isOrderedSubsequence(actual: readonly string[], expected: readonly string[]): boolean {
  let expectedIndex = 0;
  for (const value of actual) {
    if (value === expected[expectedIndex]) expectedIndex += 1;
    if (expectedIndex === expected.length) return true;
  }
  return expected.length === 0;
}

function resultComponent(name: string, pass: boolean, reason: string): GradingResult {
  return { pass, score: pass ? 1 : 0, reason, namedScores: { [name]: pass ? 1 : 0 } };
}

function requireToolConfig(value: unknown): ToolBehaviorConfig {
  if (!isObject(value)) throw new Error('toolBehavior assertion config must be an object');
  if (value['scope'] !== undefined && value['scope'] !== 'root' && value['scope'] !== 'tree') {
    throw new Error('toolBehavior scope must be root or tree');
  }
  return value as ToolBehaviorConfig;
}

/** Evaluate allowlist/required/forbidden/count/argument/sequence conditions as one AND. */
export function evaluateToolBehavior(
  calls: readonly DshToolCallView[],
  rawConfig: unknown,
): GradingResult {
  const config = requireToolConfig(rawConfig);
  const scope = config.scope ?? 'root';
  const metricPrefix = `dsh.tool.${scope}`;
  const components: GradingResult[] = [];

  if (config.allowed !== undefined) {
    if (!Array.isArray(config.allowed) || !config.allowed.every((name) => typeof name === 'string')) {
      throw new Error('allowed must be an array of tool names');
    }
    const allowed = new Set(config.allowed);
    const unexpected = [...new Set(calls.map((call) => call.name).filter((name) => !allowed.has(name)))];
    components.push(
      resultComponent(
        `${metricPrefix}.allowed`,
        unexpected.length === 0,
        unexpected.length === 0
          ? 'all observed tools are allowed'
          : `unexpected tool(s) were called: ${unexpected.join(', ')}`,
      ),
    );
  }
  for (const name of config.required ?? []) {
    const count = calls.filter((call) => call.name === name).length;
    components.push(
      resultComponent(
        `${metricPrefix}.required.${name}`,
        count > 0,
        count > 0 ? `required tool ${name} was called` : `required tool ${name} was not called`,
      ),
    );
  }
  for (const name of config.forbidden ?? []) {
    const count = calls.filter((call) => call.name === name).length;
    components.push(
      resultComponent(
        `${metricPrefix}.forbidden.${name}`,
        count === 0,
        count === 0 ? `forbidden tool ${name} was not called` : `forbidden tool ${name} was called ${count} time(s)`,
      ),
    );
  }
  for (const [name, maximum] of Object.entries(config.maximumCalls ?? {})) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new Error(`maximumCalls.${name} must be a non-negative integer`);
    }
    const count = calls.filter((call) => call.name === name).length;
    components.push(
      resultComponent(
        `${metricPrefix}.maximumCalls.${name}`,
        count <= maximum,
        count <= maximum
          ? `tool ${name} call count ${count} is within maximum ${maximum}`
          : `tool ${name} call count ${count} exceeds maximum ${maximum}`,
      ),
    );
  }
  for (const [index, condition] of (config.arguments ?? []).entries()) {
    if (!isObject(condition) || typeof condition.name !== 'string' || !isObject(condition.contains)) {
      throw new Error(`arguments[${index}] requires a tool name and object contains value`);
    }
    const namedCalls = calls.filter((call) => call.name === condition.name);
    const matching = namedCalls.some(
      (call) => call.argumentParseError === undefined && isJsonSubset(call.parsedArguments, condition.contains),
    );
    const parseFailures = namedCalls.filter((call) => call.argumentParseError !== undefined).length;
    components.push(
      resultComponent(
        `${metricPrefix}.arguments.${condition.name}.${index}`,
        matching,
        matching
          ? `tool ${condition.name} arguments contain the expected object`
          : parseFailures > 0
            ? `tool ${condition.name} arguments did not match; ${parseFailures} call(s) had invalid JSON`
            : `tool ${condition.name} arguments did not contain the expected object`,
      ),
    );
  }
  if (config.sequence !== undefined) {
    if (!Array.isArray(config.sequence) || !config.sequence.every((name) => typeof name === 'string')) {
      throw new Error('sequence must be an array of tool names');
    }
    const callsBySession = new Map<string, string[]>();
    for (const call of calls) {
      const names = callsBySession.get(call.sessionId) ?? [];
      names.push(call.name);
      callsBySession.set(call.sessionId, names);
    }
    const pass = [...callsBySession.values()].some((names) =>
      isOrderedSubsequence(names, config.sequence ?? []),
    );
    components.push(
      resultComponent(
        `${metricPrefix}.sequence`,
        pass,
        pass
          ? `tool sequence ${config.sequence.join(' -> ')} matched`
          : `tool sequence ${config.sequence.join(' -> ')} did not match`,
      ),
    );
  }

  if (components.length === 0) throw new Error('toolBehavior assertion has no conditions');
  const passed = components.filter((component) => component.pass).length;
  return {
    pass: passed === components.length,
    score: passed / components.length,
    reason:
      passed === components.length
        ? `All ${components.length} tool behavior conditions passed`
        : `${components.length - passed} of ${components.length} tool behavior conditions failed`,
    componentResults: components,
    namedScores: Object.assign({}, ...components.map((component) => component.namedScores ?? {})),
  };
}

/** Promptfoo file assertion entrypoint for DSH Tool behavior. */
export function toolBehavior(
  _output: string,
  context: AssertionValueFunctionContext,
): GradingResult {
  const metadata = metadataFrom(context);
  const config = requireToolConfig(context.config);
  const calls = (config.scope ?? 'root') === 'root' ? metadata.root.tools : metadata.observableTree.tools;
  return evaluateToolBehavior(calls, config);
}

export interface ExecutionHealthConfig {
  allowToolErrors?: string[];
  allowSubagentFailures?: Array<{ sessionId?: string; stopReason?: string }>;
}

function requireHealthConfig(value: unknown): ExecutionHealthConfig {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error('executionHealth assertion config must be an object');
  return value as ExecutionHealthConfig;
}

function allowedSubagentFailure(
  sessionId: string,
  stopReason: string,
  allowances: ExecutionHealthConfig['allowSubagentFailures'],
): boolean {
  return (allowances ?? []).some(
    (allowance) =>
      isObject(allowance) &&
      (allowance.sessionId === undefined || allowance.sessionId === sessionId) &&
      (allowance.stopReason === undefined || allowance.stopReason === stopReason),
  );
}

/** Default health policy for one trusted compact eval view. */
export function evaluateExecutionHealth(
  metadata: DshEvalMetadataV1,
  rawConfig?: unknown,
): GradingResult {
  const config = requireHealthConfig(rawConfig);
  const allowedToolErrors = new Set(config.allowToolErrors ?? []);
  const unpaired = metadata.observableTree.tools.filter((tool) => tool.status === 'unpaired');
  const toolErrors = metadata.observableTree.tools.filter(
    (tool) => tool.status === 'error' && !allowedToolErrors.has(tool.name),
  );
  const failedSubagents = metadata.sessions.filter(
    (session) =>
      session.subagent !== undefined &&
      (session.subagent.status !== 'ok' || session.subagent.stopReason !== 'completed') &&
      !allowedSubagentFailure(
        session.sessionId,
        session.subagent.stopReason,
        config.allowSubagentFailures,
      ),
  );

  const components = [
    resultComponent(
      'dsh.health.rootCompleted',
      metadata.root.finishReason === 'completed',
      metadata.root.finishReason === 'completed'
        ? 'root turn completed'
        : `root turn ended with ${metadata.root.finishReason}`,
    ),
    resultComponent(
      'dsh.health.pairedTools',
      unpaired.length === 0,
      unpaired.length === 0
        ? 'all observable Tool calls have results'
        : `${unpaired.length} observable Tool call(s) have no result`,
    ),
    resultComponent(
      'dsh.health.toolErrors',
      toolErrors.length === 0,
      toolErrors.length === 0
        ? 'no disallowed observable Tool errors'
        : `${toolErrors.length} disallowed observable Tool error(s)`,
    ),
    resultComponent(
      'dsh.health.subagents',
      failedSubagents.length === 0,
      failedSubagents.length === 0
        ? 'no disallowed observable Subagent failures'
        : `${failedSubagents.length} disallowed observable Subagent failure(s)`,
    ),
  ];
  const passed = components.filter((component) => component.pass).length;
  return {
    pass: passed === components.length,
    score: passed / components.length,
    reason:
      passed === components.length
        ? 'DSH execution health passed'
        : `${components.length - passed} execution health condition(s) failed`,
    componentResults: components,
    namedScores: Object.assign({}, ...components.map((component) => component.namedScores ?? {})),
  };
}

/** Promptfoo file assertion entrypoint for the default execution-health policy. */
export function executionHealth(
  _output: string,
  context: AssertionValueFunctionContext,
): GradingResult {
  return evaluateExecutionHealth(metadataFrom(context), context.config);
}
