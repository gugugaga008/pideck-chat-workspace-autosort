#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, status, verifyBase, buildPackage, install, restore, inspectExecutable } from './maintenance.mjs';

const [command, ...args] = process.argv.slice(2);
const options = { root: ROOT, files: [], components: [] };
const names = { '--exe': 'exe', '--package': 'packageDir', '--base-asar': 'baseAsar', '--source': 'source', '--output': 'output', '--evidence': 'evidence', '--file': 'files', '--component': 'components' };
try {
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid option ${args[i]}`);
    if (Array.isArray(options[key])) options[key].push(args[i + 1]);
    else if (options[key] !== undefined) throw new Error(`Repeated option ${args[i]}`);
    else options[key] = args[i + 1];
  }
  const required = {
    'inspect-exe': ['exe'],
    'verify-base': ['baseAsar'],
    'build-package': ['baseAsar', 'source', 'output', 'evidence'],
    status: ['exe'], install: ['exe', 'packageDir'], restore: ['exe', 'packageDir'],
  };
  if (!required[command]) throw new Error('Commands: inspect-exe / verify-base / build-package / status / install / restore. See README.md for exact commands.');
  for (const key of required[command]) if (!options[key]) throw new Error(`Missing ${key}`);
  for (const key of ['exe', 'packageDir', 'baseAsar', 'source', 'output']) {
    if (options[key] && !path.isAbsolute(options[key])) throw new Error(`Absolute path required: ${key}`);
  }
  if (command === 'build-package') {
    if (!fs.existsSync(options.evidence)) throw new Error('--evidence must reference a UTF-8 test/build evidence file');
    options.evidence = fs.readFileSync(options.evidence, 'utf8');
  }
  const action = { status, 'inspect-exe': inspectExecutable, 'verify-base': verifyBase, 'build-package': buildPackage, install, restore }[command];
  console.log(JSON.stringify(await action(options), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
