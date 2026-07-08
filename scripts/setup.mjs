#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { validateCockpitRoot, writeConfig, readConfig } from '../lib/config.mjs';
import { assertNode20, configPath, expandHome, kitRoot } from '../lib/paths.mjs';
import { initAndCommit } from '../lib/git.mjs';

const adapters = new Set(['agents', 'hermes', 'claude']);

function usage() {
  return `Usage: node scripts/setup.mjs [options]

Options:
  --cockpit-root <path>       Existing Cockpit root to link
  --adapters <list>           Comma-separated: agents,hermes,claude
  --no-create-root            Refuse to create a missing root
  --no-git                    Skip git initialization for created roots
  --dry-run                   Print planned changes without touching disk
  --force                     Overwrite conflicting config or adapter links
  --yes                       Accept defaults without prompting
  --hermes-home <path>        Override Hermes home
  --help                      Show this help
`;
}

function parseArgs(argv) {
  const options = {
    adapters: undefined,
    createRoot: true,
    git: true,
    dryRun: false,
    force: false,
    yes: false,
    cockpitRoot: undefined,
    hermesHome: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--cockpit-root') options.cockpitRoot = next();
    else if (arg.startsWith('--cockpit-root=')) options.cockpitRoot = arg.slice('--cockpit-root='.length);
    else if (arg === '--adapters') options.adapters = next();
    else if (arg.startsWith('--adapters=')) options.adapters = arg.slice('--adapters='.length);
    else if (arg === '--no-create-root') options.createRoot = false;
    else if (arg === '--no-git') options.git = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--hermes-home') options.hermesHome = next();
    else if (arg.startsWith('--hermes-home=')) options.hermesHome = arg.slice('--hermes-home='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function splitAdapters(value) {
  const selected = (value ?? 'agents,hermes,claude').split(',').map((item) => item.trim()).filter(Boolean);
  for (const adapter of selected) {
    if (!adapters.has(adapter)) throw new Error(`Unsupported adapter: ${adapter}. Expected one of: ${[...adapters].join(', ')}`);
  }
  return selected;
}

async function promptValue(question, defaultValue) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [${defaultValue}]: `);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

function resolveUserPath(value, env) {
  return path.resolve(expandHome(value, env));
}

function adapterTarget(adapter, env, options) {
  if (adapter === 'agents') return path.join(resolveUserPath('~', env), '.agents', 'skills', 'cockpit');
  if (adapter === 'claude') return path.join(resolveUserPath('~', env), '.claude', 'skills', 'cockpit');
  const hermesHome = options.hermesHome ?? env.HERMES_HOME ?? '~/.hermes';
  return path.join(resolveUserPath(hermesHome, env), 'skills', 'productivity', 'cockpit');
}

function symlinkTarget(file) {
  try {
    return fs.readlinkSync(file);
  } catch {
    return undefined;
  }
}

function sameSymlinkTarget(existing, target) {
  const link = symlinkTarget(existing);
  if (!link) return false;
  try {
    return fs.realpathSync.native(path.resolve(path.dirname(existing), link)) === fs.realpathSync.native(target);
  } catch {
    return false;
  }
}

function preflightAdapter(adapter, targetPath, targetRoot, options) {
  const existingStat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (!existingStat || sameSymlinkTarget(targetPath, targetRoot)) return;
  const prior = symlinkTarget(targetPath) ?? 'non-symlink path';
  if (!options.force) throw new Error(`${adapter} adapter conflict at ${targetPath}; existing target: ${prior}. Rerun with --force to replace it.`);
}

function installAdapter(adapter, targetPath, targetRoot, options, plan) {
  const existingStat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (existingStat) {
    if (sameSymlinkTarget(targetPath, targetRoot)) {
      plan.push({ action: 'skip', path: targetPath, detail: `${adapter} adapter already installed` });
      return;
    }
    const prior = symlinkTarget(targetPath) ?? 'non-symlink path';
    if (!options.force) throw new Error(`${adapter} adapter conflict at ${targetPath}; existing target: ${prior}. Rerun with --force to replace it.`);
    plan.push({ action: 'replace', path: targetPath, detail: `${adapter} adapter foreign path replaced; previous target: ${prior}` });
    if (!options.dryRun) fs.rmSync(targetPath, { recursive: true, force: true });
  } else {
    plan.push({ action: 'create', path: targetPath, detail: `${adapter} adapter symlink -> ${targetRoot}` });
  }
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.symlinkSync(targetRoot, targetPath, 'dir');
  }
}

function verifyWhere(targetRoot, root, env, plan) {
  const verifyEnv = { ...env };
  delete verifyEnv.COCKPIT_HOME;
  const result = spawnSync(process.execPath, [path.join(targetRoot, 'scripts', 'where.mjs'), '--json'], { env: verifyEnv, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`where.mjs verification failed: ${(result.stderr || result.stdout).trim()}`);
  const payload = JSON.parse(result.stdout);
  if (payload.cockpit_root !== root) throw new Error(`where.mjs verification resolved ${payload.cockpit_root}, expected ${root}`);
  plan.push({ action: 'verify', path: path.join(targetRoot, 'scripts', 'where.mjs'), detail: 'resolved configured Cockpit root with --json' });
}

function runChecked(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path.basename(script)} failed: ${(result.stderr || result.stdout).trim()}`);
  return result;
}

function copyTemplate(root, targetRoot, options, plan) {
  const template = path.join(targetRoot, 'templates', 'cockpit-root');
  const existing = fs.statSync(root, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw new Error(`Refusing to create because path exists and is not a directory: ${root}`);
  if (existing && fs.readdirSync(root).length > 0) throw new Error(`Refusing to create into non-empty directory: ${root}`);
  plan.push({ action: 'create', path: root, detail: `copy starter template from ${template}` });
  if (!options.dryRun) {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(template, root, { recursive: true, errorOnExist: false });
  }
}

function verifyCreatedRoot(root, targetRoot, options, plan) {
  const indexScript = path.join(targetRoot, 'scripts', 'search-index.mjs');
  const lintScript = path.join(targetRoot, 'scripts', 'lint.mjs');
  if (options.dryRun) {
    plan.push({ action: 'skip', path: path.join(root, '.cockpit', 'search-index.json'), detail: 'dry-run skipped search-index generation' });
    plan.push({ action: 'skip', path: lintScript, detail: 'dry-run skipped strict lint verification' });
    return;
  }
  validateCockpitRoot(root);
  runChecked(indexScript, ['--root', root], process.env);
  plan.push({ action: 'create', path: path.join(root, '.cockpit', 'search-index.json'), detail: 'generated deterministic search index' });
  runChecked(lintScript, ['--root', root, '--strict'], process.env);
  plan.push({ action: 'verify', path: lintScript, detail: 'created root passed strict lint' });
}

function maybeInitGit(root, options, plan) {
  if (!options.git) {
    plan.push({ action: 'skip', path: root, detail: '--no-git set; skipped initial git commit' });
    return;
  }
  if (options.dryRun) {
    plan.push({ action: 'skip', path: root, detail: 'dry-run skipped initial git commit' });
    return;
  }
  initAndCommit(root, 'chore: initialize cockpit knowledge repo', { env: process.env });
  plan.push({ action: 'create', path: path.join(root, '.git'), detail: 'initialized git and committed starter root' });
}

function preflightConfigWrite(env, root, options) {
  const existing = readConfig(env);
  if (existing.ok && existing.cockpitRoot && path.resolve(expandHome(existing.cockpitRoot, env)) !== root && !options.force) {
    throw new Error(`Config already points at ${existing.cockpitRoot}; rerun with --force to change it to ${root}.`);
  }
}

function planConfigWrite(env, root, targetRoot, options, plan) {
  preflightConfigWrite(env, root, options);
  const pathToConfig = configPath(env);
  const existing = readConfig(env);
  const action = existing.ok && existing.cockpitRoot === root ? 'skip' : fs.existsSync(pathToConfig) ? 'update' : 'create';
  plan.push({ action, path: pathToConfig, detail: `write cockpit_root and diagnostic skill_root` });
  if (!options.dryRun) writeConfig(env, { cockpit_root: root, skill_root: targetRoot });
}

function printPlan(plan) {
  for (const step of plan) process.stdout.write(`${step.action}: ${step.path} - ${step.detail}\n`);
}

async function main() {
  assertNode20();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const targetRoot = kitRoot(import.meta.url);
  const defaultRoot = '~/cockpit';
  let rootInput = options.cockpitRoot;
  if (!rootInput && options.yes) rootInput = defaultRoot;
  if (!rootInput && process.stdin.isTTY) rootInput = await promptValue('Cockpit root to link or create', defaultRoot);
  if (!rootInput) throw new Error('Missing --cockpit-root in non-interactive mode. Pass --cockpit-root <path> or rerun interactively.');

  const root = resolveUserPath(rootInput, process.env);
  const plan = [];
  const selectedAdapters = splitAdapters(options.adapters);
  const adapterTargets = selectedAdapters.map((adapter) => ({ adapter, targetPath: adapterTarget(adapter, process.env, options) }));
  preflightConfigWrite(process.env, root, options);
  for (const { adapter, targetPath } of adapterTargets) preflightAdapter(adapter, targetPath, targetRoot, options);

  const createdRoot = !fs.existsSync(root);
  if (!fs.existsSync(root)) {
    if (!options.createRoot) throw new Error(`Cockpit root does not exist and --no-create-root was set: ${root}`);
    copyTemplate(root, targetRoot, options, plan);
  }
  if (createdRoot) {
    verifyCreatedRoot(root, targetRoot, options, plan);
    maybeInitGit(root, options, plan);
  } else {
    validateCockpitRoot(root);
    plan.push({ action: 'skip', path: root, detail: 'existing Cockpit root validated; root creation not needed' });
    plan.push({ action: 'skip', path: path.join(root, '.cockpit', 'search-index.json'), detail: 'linked existing root left unchanged; run search-index.mjs manually when needed' });
    plan.push({ action: 'skip', path: path.join(targetRoot, 'scripts', 'lint.mjs'), detail: 'linked existing root lint verification left to operator' });
    if (!options.git) plan.push({ action: 'skip', path: root, detail: '--no-git set; git initialization would only apply to setup-created roots' });
    else plan.push({ action: 'skip', path: root, detail: 'git initialization applies only to setup-created roots; linked root left unchanged' });
  }

  planConfigWrite(process.env, root, targetRoot, options, plan);
  for (const { adapter, targetPath } of adapterTargets) installAdapter(adapter, targetPath, targetRoot, options, plan);
  if (!options.dryRun) verifyWhere(targetRoot, root, process.env, plan);
  else plan.push({ action: 'skip', path: path.join(targetRoot, 'scripts', 'where.mjs'), detail: 'dry-run skipped where.mjs verification' });

  printPlan(plan);
  process.stdout.write(options.dryRun ? 'Dry run complete; no filesystem changes made.\n' : 'Setup complete. Verify with: node <cockpit-kit>/scripts/where.mjs --json\n');
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
