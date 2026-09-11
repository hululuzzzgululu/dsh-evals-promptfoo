/** Runtime compatibility gate for the two exact upstream baselines. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';

import { DSH_SDK_VERSION } from './projection.js';

export const PROMPTFOO_VERSION = '0.122.2';

export interface UpstreamVersions {
  dshSdk: string;
  promptfoo: string;
}

const require = createRequire(import.meta.url);

function readPackageVersion(packageName: string): string {
  try {
    const manifest = require(`${packageName}/package.json`) as { version?: unknown };
    if (typeof manifest.version === 'string') return manifest.version;
  } catch {
    // Some packages do not export package.json; locate it from their entry.
  }

  let directory = dirname(require.resolve(packageName));
  const root = parse(directory).root;
  while (directory !== root) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === packageName && typeof manifest.version === 'string') {
        return manifest.version;
      }
    } catch {
      // Keep walking toward the filesystem root.
    }
    directory = dirname(directory);
  }
  throw new Error(`cannot determine installed version of ${packageName}`);
}

/** Read the installed versions that define the V1 adapter contract. */
export function installedUpstreamVersions(): UpstreamVersions {
  return {
    dshSdk: readPackageVersion('@deepseek-ai/dsh-sdk-client'),
    promptfoo: readPackageVersion('promptfoo'),
  };
}

/** Fail before a Runtime starts when an unverified upstream is installed. */
export function assertSupportedVersions(
  actual: UpstreamVersions = installedUpstreamVersions(),
): void {
  if (actual.dshSdk === DSH_SDK_VERSION && actual.promptfoo === PROMPTFOO_VERSION) return;
  throw new Error(
    `Unsupported upstream versions: expected @deepseek-ai/dsh-sdk-client ${DSH_SDK_VERSION} and Promptfoo ${PROMPTFOO_VERSION}, ` +
      `but found ${actual.dshSdk} and ${actual.promptfoo}. ` +
      `Restore the verified contract with npm install --save-exact @deepseek-ai/dsh-sdk-client@${DSH_SDK_VERSION} promptfoo@${PROMPTFOO_VERSION}.`,
  );
}
