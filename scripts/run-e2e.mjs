import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATASET_DOMAIN_ENV,
  discoverDatasetDomains,
  selectDatasetDomain,
} from '../dist/src/datasets.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const datasetsRoot = resolve(projectRoot, 'datasets');
const promptfooEntrypoint = resolve(projectRoot, 'node_modules/promptfoo/dist/src/entrypoint.js');

function usage() {
  console.log(`Usage:
  npm run domains
  npm run e2e
  npm run e2e -- <domain> [promptfoo options]
  npm run e2e:compare -- <domain> [promptfoo options]

A domain is either datasets/<domain>.yaml or datasets/<domain>/*.yaml.`);
}

function parseArguments(args) {
  let config = 'config/evals/default.yaml';
  let domain;
  let list = false;
  let forwarding = false;
  const promptfooArguments = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (forwarding) {
      promptfooArguments.push(argument);
    } else if (argument === '--config') {
      const value = args[index + 1];
      if (!value) throw new TypeError('--config requires a path');
      config = value;
      index += 1;
    } else if (argument === '--domain') {
      const value = args[index + 1];
      if (!value) throw new TypeError('--domain requires a name');
      domain = value;
      index += 1;
    } else if (argument === '--list') {
      list = true;
    } else if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    } else if (domain === undefined && !argument.startsWith('-')) {
      domain = argument;
    } else {
      forwarding = true;
      promptfooArguments.push(argument);
    }
  }
  return { config, domain, list, promptfooArguments };
}

function printDomains(domains) {
  console.log('Dataset domains:');
  for (const domain of domains) {
    console.log(`- ${domain.name} (${domain.files.length} YAML file${domain.files.length === 1 ? '' : 's'})`);
  }
}

async function runPromptfoo(config, domain, extraArguments) {
  const childEnvironment = { ...process.env };
  if (domain === undefined) delete childEnvironment[DATASET_DOMAIN_ENV];
  else childEnvironment[DATASET_DOMAIN_ENV] = domain;
  const domainLabel = domain ?? 'all';
  const child = spawn(
    process.execPath,
    [
      promptfooEntrypoint,
      'eval',
      '--config',
      resolve(projectRoot, config),
      '--tag',
      `domain=${domainLabel}`,
      '--description',
      `DSH Dataset domain: ${domainLabel}`,
      ...extraArguments,
    ],
    { cwd: projectRoot, env: childEnvironment, stdio: 'inherit' },
  );
  const forwardSigint = () => child.kill('SIGINT');
  const forwardSigterm = () => child.kill('SIGTERM');
  process.once('SIGINT', forwardSigint);
  process.once('SIGTERM', forwardSigterm);
  const exitCode = await new Promise((resolveExit) => {
    child.once('error', (error) => {
      console.error(error);
      resolveExit(1);
    });
    child.once('exit', (code, signal) => {
      resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
  });
  process.removeListener('SIGINT', forwardSigint);
  process.removeListener('SIGTERM', forwardSigterm);
  process.exitCode = exitCode;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const domains = discoverDatasetDomains(datasetsRoot);
  if (options.list) {
    printDomains(domains);
    return;
  }

  const selected =
    options.domain === undefined ? domains : [selectDatasetDomain(domains, options.domain)];
  console.log(
    `Running Dataset domain${selected.length === 1 ? '' : 's'}: ${selected.map((domain) => domain.name).join(', ')}`,
  );
  console.log(`Discovered ${selected.reduce((total, domain) => total + domain.files.length, 0)} YAML files.`);
  await runPromptfoo(
    options.config,
    options.domain,
    options.promptfooArguments,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
