#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { kitRoot, assertNode20, expandHome } from '../lib/paths.mjs';
import { validateCockpitRoot, writeConfig } from '../lib/config.mjs';
import { initAndCommit } from '../lib/git.mjs';

function usage() {
  return 'Usage: node scripts/link.mjs [--create] [--no-git] [--] <cockpit-root>\n';
}

function runChecked(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path.basename(script)} failed: ${(result.stderr || result.stdout).trim()}`);
  return result;
}

function copyTemplate(targetRoot, sourceRoot) {
  const existing = fs.statSync(targetRoot, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw new Error(`Refusing to create because path exists and is not a directory: ${targetRoot}`);
  if (existing && fs.readdirSync(targetRoot).length > 0) throw new Error(`Refusing to create into non-empty directory: ${targetRoot}`);
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, { recursive: true, errorOnExist: false });
}

function parseArgs(argv) {
  const options = { create: false, git: true, help: false, positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options.positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--create') options.create = true;
    else if (arg === '--no-git') options.git = false;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function createRoot(root, targetRoot, { git }) {
  copyTemplate(root, path.join(targetRoot, 'templates', 'cockpit-root'));
  validateCockpitRoot(root);
  runChecked(path.join(targetRoot, 'scripts', 'search-index.mjs'), ['--root', root], process.env);
  runChecked(path.join(targetRoot, 'scripts', 'lint.mjs'), ['--root', root, '--strict'], process.env);
  if (git) initAndCommit(root, 'chore: initialize cockpit knowledge repo', { env: process.env });
}

try {
  assertNode20();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (options.positional.length !== 1) {
    process.stderr.write(usage());
    process.exit(1);
  }
  const targetRoot = kitRoot(import.meta.url);
  const root = path.resolve(expandHome(options.positional[0], process.env));
  if (options.create) createRoot(root, targetRoot, { git: options.git });
  validateCockpitRoot(root);
  const result = writeConfig(process.env, {
    cockpit_root: root,
    skill_root: targetRoot,
  });
  process.stdout.write(`${options.create ? 'Created and linked' : 'Linked'} Cockpit root: ${root}\n`);
  process.stdout.write(`Config written: ${result.configPath}\n`);
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
