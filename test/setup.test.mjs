import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../lib/config.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const setupScript = path.join(repoRoot, 'scripts', 'setup.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRoot() {
  const root = tempDir('cockpit-setup-root-');
  fs.mkdirSync(path.join(root, '.cockpit'));
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  return root;
}

function makeEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  delete env.COCKPIT_HOME;
  if (!Object.hasOwn(extra, 'XDG_CONFIG_HOME')) delete env.XDG_CONFIG_HOME;
  if (!Object.hasOwn(extra, 'HERMES_HOME')) delete env.HERMES_HOME;
  return env;
}

function runSetup(args, env) {
  return spawnSync(process.execPath, [setupScript, ...args], { cwd: repoRoot, env, encoding: 'utf8' });
}

function assertSymlink(targetPath) {
  const stat = fs.lstatSync(targetPath);
  assert.equal(stat.isSymbolicLink(), true);
  assert.equal(fs.realpathSync.native(targetPath), fs.realpathSync.native(repoRoot));
}

test('setup installs agents adapter fresh and idempotently', () => {
  const home = tempDir('cockpit-setup-home-');
  const root = makeRoot();
  const env = makeEnv(home);
  const target = path.join(home, '.agents', 'skills', 'cockpit');

  const first = runSetup(['--cockpit-root', root, '--adapters', 'agents', '--yes'], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /create: .*\.agents\/skills\/cockpit/);
  assertSymlink(target);

  const second = runSetup(['--cockpit-root', root, '--adapters', 'agents', '--yes'], env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already installed/);
  assertSymlink(target);
});

test('setup refuses foreign adapter symlink unless forced', () => {
  const home = tempDir('cockpit-setup-home-');
  const root = makeRoot();
  const env = makeEnv(home);
  const target = path.join(home, '.agents', 'skills', 'cockpit');
  const foreign = tempDir('cockpit-foreign-skill-');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(foreign, target, 'dir');

  const blocked = runSetup(['--cockpit-root', root, '--adapters', 'agents', '--yes'], env);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /adapter conflict/);
  assert.equal(fs.realpathSync.native(target), fs.realpathSync.native(foreign));
  assert.equal(fs.existsSync(path.join(home, '.config', 'cockpit', 'config.toml')), false);

  const forced = runSetup(['--cockpit-root', root, '--adapters', 'agents', '--yes', '--force'], env);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /previous target/);
  assertSymlink(target);
});

test('setup treats equivalent realpath adapter symlinks as already installed', () => {
  const home = tempDir('cockpit-setup-home-');
  const root = makeRoot();
  const env = makeEnv(home);
  const target = path.join(home, '.agents', 'skills', 'cockpit');
  const alias = path.join(tempDir('cockpit-kit-alias-parent-'), 'kit-alias');
  fs.symlinkSync(repoRoot, alias, 'dir');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(alias, target, 'dir');

  const result = runSetup(['--cockpit-root', root, '--adapters', 'agents', '--yes'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already installed/);
  assertSymlink(target);
});

test('setup dry-run leaves filesystem untouched', () => {
  const home = tempDir('cockpit-setup-home-');
  const root = makeRoot();
  const env = makeEnv(home);
  const result = runSetup(['--cockpit-root', root, '--adapters', 'agents,hermes,claude', '--dry-run', '--yes'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run complete/);
  assert.equal(fs.existsSync(path.join(home, '.config', 'cockpit', 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(home, '.agents')), false);
  assert.equal(fs.existsSync(path.join(home, '.hermes')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
});

test('setup writes config outside kit and root', () => {
  const home = tempDir('cockpit-setup-home-');
  const xdg = tempDir('cockpit-setup-xdg-');
  const root = makeRoot();
  const env = makeEnv(home, { XDG_CONFIG_HOME: xdg });
  const result = runSetup(['--cockpit-root', root, '--adapters', 'agents', '--yes'], env);
  assert.equal(result.status, 0, result.stderr);

  const config = readConfig(env);
  assert.equal(config.cockpitRoot, root);
  assert.equal(config.skillRoot, repoRoot);
  assert.equal(config.configPath, path.join(xdg, 'cockpit', 'config.toml'));
  assert.equal(config.configPath.startsWith(repoRoot), false);
  assert.equal(config.configPath.startsWith(root), false);
});

test('setup installs all adapters and exposes canonical frontmatter through each', () => {
  const home = tempDir('cockpit-setup-home-');
  const hermesHome = path.join(home, 'custom-hermes');
  const root = makeRoot();
  const env = makeEnv(home);
  const result = runSetup(['--cockpit-root', root, '--adapters', 'agents,hermes,claude', '--hermes-home', hermesHome, '--yes'], env);
  assert.equal(result.status, 0, result.stderr);

  const targets = [
    path.join(home, '.agents', 'skills', 'cockpit', 'SKILL.md'),
    path.join(hermesHome, 'skills', 'productivity', 'cockpit', 'SKILL.md'),
    path.join(home, '.claude', 'skills', 'cockpit', 'SKILL.md'),
  ];
  for (const skillFile of targets) {
    const text = fs.readFileSync(skillFile, 'utf8');
    assert.match(text, /^---\nname: cockpit\ndescription:/);
    assert.match(text, /node <skill-dir>\/scripts\/where\.mjs --json/);
  }
});

test('setup fails non-interactively without cockpit root input', () => {
  const home = tempDir('cockpit-setup-home-');
  const result = runSetup(['--adapters', 'agents'], makeEnv(home));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing --cockpit-root/);
});

test('setup creates starter root, search index, strict-lints, and links config', () => {
  const home = tempDir('cockpit-setup-home-');
  const missing = path.join(home, 'cockpit');
  const env = makeEnv(home);
  const result = runSetup(['--cockpit-root', missing, '--adapters', 'agents', '--yes', '--no-git'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(missing, 'index.html')), true);
  assert.equal(fs.existsSync(path.join(missing, 'search', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(missing, '.cockpit', 'search-index.json')), true);
  assert.match(result.stdout, /created root passed strict lint/);
  assert.equal(readConfig(env).cockpitRoot, missing);
});

test('setup reports file cockpit root create target clearly', () => {
  const home = tempDir('cockpit-setup-home-');
  const fileRoot = path.join(home, 'not-a-directory');
  fs.writeFileSync(fileRoot, 'not a directory', 'utf8');
  const result = runSetup(['--cockpit-root', fileRoot, '--adapters', 'agents', '--yes', '--no-git'], makeEnv(home));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a directory/);
});

test('setup preflights config conflicts before creating a missing root', () => {
  const home = tempDir('cockpit-setup-home-');
  const existing = makeRoot();
  const missing = path.join(home, 'new-cockpit');
  const env = makeEnv(home);
  const first = runSetup(['--cockpit-root', existing, '--adapters', 'agents', '--yes'], env);
  assert.equal(first.status, 0, first.stderr);

  const blocked = runSetup(['--cockpit-root', missing, '--adapters', 'agents', '--yes', '--no-git'], env);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Config already points/);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(readConfig(env).cockpitRoot, existing);
});
