import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { parse } from 'yaml';

import {
  DATASET_DOMAIN_ENV,
  DatasetCatalogError,
  discoverDatasetDomains,
  loadDatasetCases,
  loadPromptfooDatasets,
  selectDatasetDomain,
} from '../src/datasets.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDatasets(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-datasets-test-'));
  temporaryDirectories.push(root);
  return root;
}

async function addYaml(
  root: string,
  path: string,
  contents = '- vars: { prompt: test }\n',
): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

function assertions(testCase: Record<string, unknown>): Array<Record<string, unknown>> {
  return testCase['assert'] as Array<Record<string, unknown>>;
}

describe('Dataset domain discovery', () => {
  it('merges root and directory Cases while keeping domain defaults out of the Case list', async () => {
    const root = await temporaryDatasets();
    await addYaml(root, '实时同步.yaml');
    await addYaml(root, '实时同步/tools.yaml');
    await addYaml(root, '实时同步/_defaults.yaml', 'assert: []\n');
    await addYaml(root, '离线开发/case.yml');

    const domains = discoverDatasetDomains(root);

    assert.deepEqual(
      domains.map(({ name, files, defaultsFile }) => ({
        name,
        files: files.map((path) => basename(path)),
        defaultsFile: defaultsFile === undefined ? undefined : basename(defaultsFile),
      })),
      [
        { name: '实时同步', files: ['实时同步.yaml', 'tools.yaml'], defaultsFile: '_defaults.yaml' },
        { name: '离线开发', files: ['case.yml'], defaultsFile: undefined },
      ],
    );
  });

  it('rejects YAML below the one supported directory level', async () => {
    const root = await temporaryDatasets();
    await addYaml(root, '镜像管理/images/case.yaml');

    assert.throws(
      () => discoverDatasetDomains(root),
      (error: unknown) =>
        error instanceof DatasetCatalogError && /nested only one directory/.test(error.message),
    );
  });

  it('rejects a domain defaults file without any Case YAML', async () => {
    const root = await temporaryDatasets();
    await addYaml(root, 'realtime-sync/_defaults.yaml', 'assert: []\n');

    assert.throws(() => discoverDatasetDomains(root), /defaults file but no Case YAML/);
  });

  it('selects known domains and reports every available name for an unknown domain', () => {
    const domains = discoverDatasetDomains(resolve('datasets'));
    const helloworld = selectDatasetDomain(domains, 'helloworld');

    assert.equal(helloworld.files.length, 3);
    assert.equal(basename(helloworld.defaultsFile ?? ''), '_defaults.yaml');
    assert.throws(
      () => selectDatasetDomain(domains, 'missing'),
      /available domains: helloworld, smoke/,
    );
  });
});

describe('Dataset defaults loader', () => {
  it('adds global health, domain assertions, domain metadata, and owner-relative file paths', async () => {
    const root = await temporaryDatasets();
    await addYaml(
      root,
      'realtime-sync/_defaults.yaml',
      `assert:
  - type: javascript
    value: file://./domain-assertion.js:toolBehavior
    config: { allowed: [read] }
`,
    );
    await addYaml(
      root,
      'realtime-sync/cases.yaml',
      `- metadata: { caseId: realtime-read }
  vars: { prompt: test }
  assert:
    - type: javascript
      value: file://./case-assertion.js:rootMetrics
    - type: equals
      value: ok
`,
    );

    const [testCase] = loadDatasetCases(root, 'realtime-sync');
    assert.ok(testCase);
    assert.deepEqual(testCase['metadata'], { caseId: 'realtime-read', domain: 'realtime-sync' });
    assert.equal(assertions(testCase).length, 4);
    assert.match(String(assertions(testCase)[0]?.['value']), /\/assertions\.js:executionHealth$/);
    assert.equal(
      assertions(testCase)[1]?.['value'],
      `file://${resolve(root, 'realtime-sync/domain-assertion.js')}:toolBehavior`,
    );
    assert.equal(
      assertions(testCase)[2]?.['value'],
      `file://${resolve(root, 'realtime-sync/case-assertion.js')}:rootMetrics`,
    );
    assert.equal(assertions(testCase)[3]?.['type'], 'equals');
  });

  it('lets a Case executionHealth policy replace both domain and global health defaults', async () => {
    const root = await temporaryDatasets();
    await addYaml(
      root,
      'offline-sync/_defaults.yaml',
      `assert:
  - type: javascript
    value: file://../../health.js:executionHealth
    config: { allowToolErrors: [domain-error] }
`,
    );
    await addYaml(
      root,
      'offline-sync/case.yaml',
      `vars: { prompt: test }
assert:
  - type: javascript
    value: file://../../health.js:executionHealth
    config: { allowToolErrors: [case-error] }
`,
    );

    const [testCase] = loadDatasetCases(root, 'offline-sync');
    assert.ok(testCase);
    const healthAssertions = assertions(testCase).filter((assertion) =>
      String(assertion['value']).endsWith(':executionHealth'),
    );

    assert.equal(healthAssertions.length, 1);
    assert.deepEqual(healthAssertions[0]?.['config'], { allowToolErrors: ['case-error'] });
  });

  it('rejects non-assert fields in domain defaults', async () => {
    const root = await temporaryDatasets();
    await addYaml(root, 'image-management/case.yaml');
    await addYaml(
      root,
      'image-management/_defaults.yaml',
      'metadata: { owner: image-team }\nassert: []\n',
    );

    assert.throws(() => loadDatasetCases(root), /only assert is supported/);
  });

  it('exposes the same environment-selected loader seam used by the runner and Promptfoo', async () => {
    const root = await temporaryDatasets();
    await addYaml(root, 'one.yaml');
    await addYaml(root, 'two.yaml');
    const previousDomain = process.env[DATASET_DOMAIN_ENV];

    process.env[DATASET_DOMAIN_ENV] = 'two';
    try {
      const loaded = loadPromptfooDatasets({ datasetsRoot: root });

      assert.equal(loaded.length, 1);
      assert.equal((loaded[0]?.['metadata'] as Record<string, unknown>)['domain'], 'two');
    } finally {
      if (previousDomain === undefined) delete process.env[DATASET_DOMAIN_ENV];
      else process.env[DATASET_DOMAIN_ENV] = previousDomain;
    }
  });

  it('keeps both standard run configs on the normalized Dataset loader', () => {
    for (const name of ['default', 'compare']) {
      const config = parse(readFileSync(resolve('config/evals', `${name}.yaml`), 'utf8')) as {
        defaultTest?: unknown;
        tests?: unknown;
      };
      assert.equal(config.tests, 'file://../../dist/src/datasets.js:loadPromptfooDatasets');
      assert.equal(config.defaultTest, 'file://../judger.yaml');
    }
  });
});
