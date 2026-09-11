import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(repositoryRoot, 'dist');

if (dirname(outputDirectory) !== repositoryRoot || basename(outputDirectory) !== 'dist') {
  throw new Error(`refusing to clean unexpected output directory: ${outputDirectory}`);
}

await rm(outputDirectory, { recursive: true, force: true });

