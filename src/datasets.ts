/**
 * Discover and load the repository's shallow, domain-oriented Dataset tree.
 *
 * A root YAML file contributes the domain named by its filename. A first-level
 * directory contributes the domain named by the directory. Both forms may
 * coexist and are merged into one domain. A domain directory may also contain
 * `_defaults.yaml`, whose assertions are inherited by every Case in that domain.
 *
 * @module dsh-evals-promptfoo/datasets
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const DOMAIN_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
const DEFAULTS_FILENAMES = new Set(['_defaults.yaml', '_defaults.yml']);
const JAVASCRIPT_OR_PYTHON = /\.(?:[cm]?[jt]s|py)$/iu;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIRECTORY, '../..');
const DEFAULT_DATASETS_ROOT = resolve(PROJECT_ROOT, 'datasets');

export const DATASET_DOMAIN_ENV = 'DSH_EVAL_DATASET_DOMAIN';

type JsonObject = Record<string, unknown>;

export interface DatasetDomain {
  name: string;
  /** Absolute Case YAML paths in deterministic lexical order. */
  files: string[];
  /** Absolute domain-default path, when present. */
  defaultsFile?: string;
}

interface MutableDatasetDomain {
  files: string[];
  defaultsFile?: string;
}

export interface DatasetLoadOptions {
  /** Absolute path, or a path relative to the repository root. */
  datasetsRoot?: string;
  /** Omit to load every discovered domain. */
  domain?: string;
}

export class DatasetCatalogError extends Error {
  override readonly name = 'DatasetCatalogError';
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isYaml(path: string): boolean {
  return YAML_EXTENSIONS.has(extname(path));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireDomainName(name: string, path: string): string {
  if (!DOMAIN_NAME.test(name)) {
    throw new DatasetCatalogError(
      `Dataset domain ${JSON.stringify(name)} from ${path} must use letters, numbers, dot, dash, or underscore`,
    );
  }
  return name;
}

function domainNameFromRootFile(filename: string, path: string): string {
  return requireDomainName(filename.slice(0, -extname(filename).length), path);
}

/** Discover every root-file and first-level-directory Dataset domain. */
export function discoverDatasetDomains(datasetsRoot: string): DatasetDomain[] {
  const root = resolve(datasetsRoot);
  const domains = new Map<string, MutableDatasetDomain>();
  const tooDeep: string[] = [];

  const domainEntry = (domain: string): MutableDatasetDomain => {
    const existing = domains.get(domain);
    if (existing !== undefined) return existing;
    const created: MutableDatasetDomain = { files: [] };
    domains.set(domain, created);
    return created;
  };

  const addCaseFile = (domain: string, path: string): void => {
    domainEntry(domain).files.push(path);
  };

  const setDefaultsFile = (domain: string, path: string): void => {
    const entry = domainEntry(domain);
    if (entry.defaultsFile !== undefined) {
      throw new DatasetCatalogError(
        `Dataset domain ${JSON.stringify(domain)} has multiple defaults files: ${entry.defaultsFile}, ${path}`,
      );
    }
    entry.defaultsFile = path;
  };

  const visit = (directory: string, segments: string[]): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const nextSegments = [...segments, entry.name];
      if (entry.isDirectory()) {
        visit(path, nextSegments);
        continue;
      }
      if (!entry.isFile() || !isYaml(entry.name)) continue;
      if (nextSegments.length > 2) {
        tooDeep.push(path);
        continue;
      }
      if (nextSegments.length === 2 && DEFAULTS_FILENAMES.has(entry.name)) {
        const domain = requireDomainName(nextSegments[0]!, path);
        setDefaultsFile(domain, path);
        continue;
      }
      const domain =
        nextSegments.length === 1
          ? domainNameFromRootFile(entry.name, path)
          : requireDomainName(nextSegments[0]!, path);
      addCaseFile(domain, path);
    }
  };

  try {
    visit(root, []);
  } catch (cause) {
    if (cause instanceof DatasetCatalogError) throw cause;
    throw new DatasetCatalogError(`Cannot read Dataset directory ${root}`, { cause });
  }

  if (tooDeep.length > 0) {
    throw new DatasetCatalogError(
      `Dataset YAML may be nested only one directory below ${root}: ${tooDeep.sort(lexicalCompare).join(', ')}`,
    );
  }
  if (domains.size === 0) throw new DatasetCatalogError(`No Dataset Case YAML found under ${root}`);

  return [...domains]
    .sort(([left], [right]) => lexicalCompare(left, right))
    .map(([name, entry]) => {
      if (entry.files.length === 0) {
        throw new DatasetCatalogError(
          `Dataset domain ${JSON.stringify(name)} has a defaults file but no Case YAML`,
        );
      }
      const domain: DatasetDomain = { name, files: entry.files.sort(lexicalCompare) };
      if (entry.defaultsFile !== undefined) domain.defaultsFile = entry.defaultsFile;
      return domain;
    });
}

/** Find one discovered domain, failing with the available names when absent. */
export function selectDatasetDomain(
  domains: readonly DatasetDomain[],
  name: string,
): DatasetDomain {
  const selected = domains.find((domain) => domain.name === name);
  if (selected !== undefined) return selected;
  throw new DatasetCatalogError(
    `Unknown Dataset domain ${JSON.stringify(name)}; available domains: ${domains.map((domain) => domain.name).join(', ')}`,
  );
}

function parseYaml(path: string): unknown {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new DatasetCatalogError(`Cannot parse Dataset YAML ${path}`, { cause });
  }
}

function requireAssertions(value: unknown, path: string): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isObject)) {
    throw new DatasetCatalogError(`Dataset assert in ${path} must be an array of assertion objects`);
  }
  return value;
}

function splitFunctionReference(reference: string): { path: string; suffix: string } {
  const lastColon = reference.lastIndexOf(':');
  if (lastColon > 1) {
    const candidate = reference.slice(0, lastColon);
    if (JAVASCRIPT_OR_PYTHON.test(candidate)) {
      return { path: candidate, suffix: reference.slice(lastColon) };
    }
  }
  return { path: reference, suffix: '' };
}

function resolveFileReference(value: string, ownerPath: string): string {
  if (!value.startsWith('file://')) return value;
  const reference = splitFunctionReference(value.slice('file://'.length));
  const path = isAbsolute(reference.path)
    ? reference.path
    : resolve(dirname(ownerPath), reference.path);
  return `file://${path}${reference.suffix}`;
}

function resolveOwnedFileReferences(value: unknown, ownerPath: string): unknown {
  if (typeof value === 'string') return resolveFileReference(value, ownerPath);
  if (Array.isArray(value)) {
    return value.map((item) => resolveOwnedFileReferences(item, ownerPath));
  }
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveOwnedFileReferences(item, ownerPath)]),
  );
}

function readDomainAssertions(domain: DatasetDomain): JsonObject[] {
  if (domain.defaultsFile === undefined) return [];
  const rawDefaults = parseYaml(domain.defaultsFile);
  if (!isObject(rawDefaults)) {
    throw new DatasetCatalogError(
      `Dataset defaults ${domain.defaultsFile} must be an object containing assert`,
    );
  }
  const unknown = Object.keys(rawDefaults).filter((key) => key !== 'assert');
  if (unknown.length > 0) {
    throw new DatasetCatalogError(
      `Dataset defaults ${domain.defaultsFile} has unsupported fields: ${unknown.join(', ')}; only assert is supported`,
    );
  }
  return requireAssertions(rawDefaults['assert'], domain.defaultsFile).map(
    (assertion) => resolveOwnedFileReferences(assertion, domain.defaultsFile!) as JsonObject,
  );
}

function isExecutionHealthAssertion(assertion: JsonObject): boolean {
  return (
    assertion['type'] === 'javascript' &&
    typeof assertion['value'] === 'string' &&
    assertion['value'].endsWith(':executionHealth')
  );
}

function singleHealthAssertion(assertions: JsonObject[], path: string): JsonObject | undefined {
  const matches = assertions.filter(isExecutionHealthAssertion);
  if (matches.length > 1) {
    throw new DatasetCatalogError(`${path} defines executionHealth more than once`);
  }
  return matches[0];
}

function defaultHealthAssertion(): JsonObject {
  return {
    type: 'javascript',
    value: `file://${resolve(MODULE_DIRECTORY, 'assertions.js')}:executionHealth`,
  };
}

function readCases(path: string): JsonObject[] {
  const raw = parseYaml(path);
  const cases = Array.isArray(raw) ? raw : [raw];
  if (!cases.every(isObject)) {
    throw new DatasetCatalogError(`Dataset ${path} must contain a Case object or an array of Case objects`);
  }
  return cases;
}

function loadDomainCases(domain: DatasetDomain): JsonObject[] {
  const domainAssertions = readDomainAssertions(domain);
  const domainHealth = singleHealthAssertion(
    domainAssertions,
    domain.defaultsFile ?? `Dataset domain ${domain.name}`,
  );
  const inheritedAssertions = domainAssertions.filter(
    (assertion) => !isExecutionHealthAssertion(assertion),
  );

  return domain.files.flatMap((path) =>
    readCases(path).map((rawCase) => {
      const testCase = resolveOwnedFileReferences(rawCase, path) as JsonObject;
      const caseAssertions = requireAssertions(testCase['assert'], path);
      const caseHealth = singleHealthAssertion(caseAssertions, path);
      const metadata = testCase['metadata'];
      if (metadata !== undefined && !isObject(metadata)) {
        throw new DatasetCatalogError(`Dataset metadata in ${path} must be an object`);
      }
      if (isObject(metadata) && metadata['domain'] !== undefined && metadata['domain'] !== domain.name) {
        throw new DatasetCatalogError(
          `Dataset metadata.domain in ${path} must match discovered domain ${JSON.stringify(domain.name)}`,
        );
      }
      return {
        ...testCase,
        metadata: { ...(metadata ?? {}), domain: domain.name },
        assert: [
          caseHealth ?? domainHealth ?? defaultHealthAssertion(),
          ...inheritedAssertions,
          ...caseAssertions.filter((assertion) => !isExecutionHealthAssertion(assertion)),
        ],
      };
    }),
  );
}

/** Load normalized Promptfoo Cases for one domain, or for the complete catalog. */
export function loadDatasetCases(datasetsRoot: string, domain?: string): JsonObject[] {
  const domains = discoverDatasetDomains(datasetsRoot);
  const selected = domain === undefined ? domains : [selectDatasetDomain(domains, domain)];
  return selected.flatMap(loadDomainCases);
}

function requireLoadOptions(rawOptions: unknown): DatasetLoadOptions {
  if (rawOptions === undefined) return {};
  if (!isObject(rawOptions)) throw new DatasetCatalogError('Dataset loader config must be an object');
  const unknown = Object.keys(rawOptions).filter(
    (key) => key !== 'datasetsRoot' && key !== 'domain',
  );
  if (unknown.length > 0) {
    throw new DatasetCatalogError(`Unknown Dataset loader config fields: ${unknown.join(', ')}`);
  }
  if (rawOptions['datasetsRoot'] !== undefined && typeof rawOptions['datasetsRoot'] !== 'string') {
    throw new DatasetCatalogError('Dataset loader datasetsRoot must be a string');
  }
  if (rawOptions['domain'] !== undefined && typeof rawOptions['domain'] !== 'string') {
    throw new DatasetCatalogError('Dataset loader domain must be a string');
  }
  return rawOptions as DatasetLoadOptions;
}

/** Promptfoo JavaScript Dataset entrypoint used by every checked-in run config. */
export function loadPromptfooDatasets(rawOptions?: unknown): JsonObject[] {
  const options = requireLoadOptions(rawOptions);
  const datasetsRoot =
    options.datasetsRoot === undefined
      ? DEFAULT_DATASETS_ROOT
      : resolve(PROJECT_ROOT, options.datasetsRoot);
  const environmentDomain = process.env[DATASET_DOMAIN_ENV]?.trim();
  const domain = options.domain ?? (environmentDomain === '' ? undefined : environmentDomain);
  return loadDatasetCases(datasetsRoot, domain);
}
