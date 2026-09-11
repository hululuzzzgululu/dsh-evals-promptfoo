/**
 * Load the one checked-in Candidate definition and resolve its environment
 * references without exposing deployment values in Promptfoo YAML.
 *
 * @module dsh-evals-promptfoo/candidate
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parse } from 'yaml';

import type { DshProviderConfig } from './runtime.js';

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CANDIDATE_KEYS = new Set([
  'dshBin',
  'profile',
  'patches',
  'dshHome',
  'processCwd',
  'cwd',
  'provider',
  'model',
  'reasoningEffort',
  'maxTokens',
  'initializeTimeoutMs',
  'requestTimeoutMs',
  'shutdownTimeoutMs',
  'disposeEofGraceMs',
  'disposeGraceMs',
  'inheritEnv',
  'evalData',
]);

const MODEL_KEYS = new Set(['nameEnv', 'baseUrlEnv', 'apiKeyEnv']);

/** Small Promptfoo-facing Interface shared by every eval configuration. */
export interface CandidateProviderConfig {
  /** Candidate YAML path, relative to the Promptfoo config directory. */
  candidateConfig: string;
  /** Optional per-eval override used by comparison runs. */
  reasoningEffort?: DshProviderConfig['reasoningEffort'];
  /** Promptfoo injects the directory containing its eval config here. */
  basePath?: string;
}

interface CandidateModelEnvironment {
  nameEnv: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
}

interface CandidateFileConfig {
  dshBin?: string;
  profile?: string;
  patches?: string[];
  dshHome?: string;
  processCwd?: string;
  cwd?: string;
  provider?: string;
  model: CandidateModelEnvironment;
  reasoningEffort?: DshProviderConfig['reasoningEffort'];
  maxTokens?: number;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  disposeEofGraceMs?: number;
  disposeGraceMs?: number;
  inheritEnv?: boolean;
  evalData?: DshProviderConfig['evalData'];
}

/** Candidate configuration could not be loaded without ambiguity. */
export class CandidateConfigError extends Error {
  override readonly name = 'CandidateConfigError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  location: string,
): void {
  const unknownKeys = Object.keys(value).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new CandidateConfigError(`${location} contains unknown fields: ${unknownKeys.join(', ')}`);
  }
}

function requireNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CandidateConfigError(`${location} must be a non-empty string`);
  }
  return value.trim();
}

function requireEnvironmentName(value: unknown, location: string): string {
  const name = requireNonEmptyString(value, location);
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new CandidateConfigError(`${location} must be an environment variable name`);
  }
  return name;
}

function optionalString(value: unknown, location: string): void {
  if (value !== undefined) requireNonEmptyString(value, location);
}

function optionalNonNegativeInteger(value: unknown, location: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
    throw new CandidateConfigError(`${location} must be a non-negative integer`);
  }
}

function parseCandidateFile(contents: string, path: string): CandidateFileConfig {
  let parsed: unknown;
  try {
    parsed = parse(contents);
  } catch (cause) {
    throw new CandidateConfigError(`cannot parse Candidate config ${path}`, { cause });
  }
  if (!isRecord(parsed)) throw new CandidateConfigError(`Candidate config ${path} must be an object`);
  assertKnownKeys(parsed, CANDIDATE_KEYS, `Candidate config ${path}`);

  optionalString(parsed['dshBin'], 'candidate.dshBin');
  optionalString(parsed['profile'], 'candidate.profile');
  optionalString(parsed['dshHome'], 'candidate.dshHome');
  optionalString(parsed['processCwd'], 'candidate.processCwd');
  optionalString(parsed['cwd'], 'candidate.cwd');
  optionalString(parsed['provider'], 'candidate.provider');
  optionalString(parsed['reasoningEffort'], 'candidate.reasoningEffort');
  if (
    parsed['patches'] !== undefined &&
    (!Array.isArray(parsed['patches']) ||
      !parsed['patches'].every((entry) => typeof entry === 'string' && entry.trim().length > 0))
  ) {
    throw new CandidateConfigError('candidate.patches must be an array of non-empty strings');
  }
  for (const key of [
    'maxTokens',
    'initializeTimeoutMs',
    'requestTimeoutMs',
    'shutdownTimeoutMs',
    'disposeEofGraceMs',
    'disposeGraceMs',
  ]) {
    optionalNonNegativeInteger(parsed[key], `candidate.${key}`);
  }
  if (parsed['inheritEnv'] !== undefined && typeof parsed['inheritEnv'] !== 'boolean') {
    throw new CandidateConfigError('candidate.inheritEnv must be a boolean');
  }
  if (parsed['evalData'] !== undefined && !isRecord(parsed['evalData'])) {
    throw new CandidateConfigError('candidate.evalData must be an object');
  }

  const model = parsed['model'];
  if (!isRecord(model)) throw new CandidateConfigError('candidate.model must be an object');
  assertKnownKeys(model, MODEL_KEYS, 'candidate.model');
  const normalizedModel: CandidateModelEnvironment = {
    nameEnv: requireEnvironmentName(model['nameEnv'], 'candidate.model.nameEnv'),
    baseUrlEnv: requireEnvironmentName(model['baseUrlEnv'], 'candidate.model.baseUrlEnv'),
    apiKeyEnv: requireEnvironmentName(model['apiKeyEnv'], 'candidate.model.apiKeyEnv'),
  };

  return { ...(parsed as Omit<CandidateFileConfig, 'model'>), model: normalizedModel };
}

function optionalEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Resolve one Candidate file into the SDK configuration used for every case.
 * Empty deployment variables mean "do not override the SDK/profile default".
 */
export function loadCandidateConfig(
  reference: CandidateProviderConfig,
  environment: NodeJS.ProcessEnv = process.env,
): DshProviderConfig {
  const candidateReference = requireNonEmptyString(
    reference.candidateConfig,
    'provider.config.candidateConfig',
  );
  const candidatePath = resolve(reference.basePath ?? process.cwd(), candidateReference);
  let contents: string;
  try {
    contents = readFileSync(candidatePath, 'utf8');
  } catch (cause) {
    throw new CandidateConfigError(`cannot read Candidate config ${candidatePath}`, { cause });
  }

  const parsed = parseCandidateFile(contents, candidatePath);
  const { model, ...runtimeConfig } = parsed;
  const modelName = optionalEnvironmentValue(environment, model.nameEnv);
  const apiKey = optionalEnvironmentValue(environment, model.apiKeyEnv);
  const baseUrl = optionalEnvironmentValue(environment, model.baseUrlEnv);

  const resolved: DshProviderConfig = {
    basePath: dirname(candidatePath),
  };
  Object.assign(resolved, runtimeConfig);
  if (apiKey !== undefined || baseUrl !== undefined) {
    resolved.envOverrides = {};
    if (apiKey !== undefined) resolved.envOverrides['DEEPSEEK_API_KEY'] = apiKey;
    if (baseUrl !== undefined) resolved.envOverrides['DEEPSEEK_BASE_URL'] = baseUrl;
  }
  if (modelName !== undefined) resolved.model = modelName;
  if (reference.reasoningEffort !== undefined) {
    resolved.reasoningEffort = reference.reasoningEffort;
  }
  return resolved;
}
