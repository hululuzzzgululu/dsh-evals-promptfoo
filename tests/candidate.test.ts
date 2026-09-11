import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { CandidateConfigError, loadCandidateConfig } from '../src/candidate.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function candidateFile(contents: string): Promise<{
  basePath: string;
  candidateConfig: string;
  candidateDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-candidate-test-'));
  temporaryDirectories.push(root);
  const evalDirectory = join(root, 'evals');
  const path = join(root, 'candidate.yaml');
  await mkdir(evalDirectory);
  await writeFile(path, contents, 'utf8');
  return {
    basePath: evalDirectory,
    candidateConfig: '../candidate.yaml',
    candidateDirectory: dirname(path),
  };
}

describe('Candidate configuration', () => {
  it('loads one structural config and maps deployment variables into DSH options', async () => {
    const reference = await candidateFile(`
profile: sdk
provider: deepseek-official
patches: [patches/eval.yml]
cwd: ..
model:
  nameEnv: CANDIDATE_MODEL_NAME
  baseUrlEnv: CANDIDATE_BASE_URL
  apiKeyEnv: CANDIDATE_API_KEY
`);
    const config = loadCandidateConfig(
      { ...reference, reasoningEffort: 'high' as never },
      {
        CANDIDATE_MODEL_NAME: 'candidate-model',
        CANDIDATE_BASE_URL: 'https://candidate.example/v1',
        CANDIDATE_API_KEY: 'candidate-secret',
      },
    );

    assert.equal(config.basePath, reference.candidateDirectory);
    assert.equal(config.profile, 'sdk');
    assert.equal(config.provider, 'deepseek-official');
    assert.equal(config.model, 'candidate-model');
    assert.equal(config.reasoningEffort, 'high');
    assert.deepEqual(config.envOverrides, {
      DEEPSEEK_API_KEY: 'candidate-secret',
      DEEPSEEK_BASE_URL: 'https://candidate.example/v1',
    });
    assert.equal('CANDIDATE_API_KEY' in (config.envOverrides ?? {}), false);
  });

  it('leaves SDK/profile defaults in control when deployment variables are empty', async () => {
    const reference = await candidateFile(`
profile: sdk
model:
  nameEnv: CANDIDATE_MODEL_NAME
  baseUrlEnv: CANDIDATE_BASE_URL
  apiKeyEnv: CANDIDATE_API_KEY
`);
    const config = loadCandidateConfig(reference, {
      CANDIDATE_MODEL_NAME: ' ',
      CANDIDATE_BASE_URL: '',
      CANDIDATE_API_KEY: '',
    });

    assert.equal(config.model, undefined);
    assert.equal(config.envOverrides, undefined);
  });

  it('rejects unknown fields and malformed environment variable names', async () => {
    const unknown = await candidateFile(`
profile: sdk
secret: inline-value
model:
  nameEnv: CANDIDATE_MODEL_NAME
  baseUrlEnv: CANDIDATE_BASE_URL
  apiKeyEnv: CANDIDATE_API_KEY
`);
    assert.throws(
      () => loadCandidateConfig(unknown, {}),
      (error: unknown) =>
        error instanceof CandidateConfigError && /unknown fields: secret/.test(error.message),
    );

    const malformed = await candidateFile(`
profile: sdk
model:
  nameEnv: candidate-model-name
  baseUrlEnv: CANDIDATE_BASE_URL
  apiKeyEnv: CANDIDATE_API_KEY
`);
    assert.throws(
      () => loadCandidateConfig(malformed, {}),
      /candidate\.model\.nameEnv must be an environment variable name/,
    );
  });
});
