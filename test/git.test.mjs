import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitAvailable, identityConfigured, initAndCommit } from '../lib/git.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('gitAvailable reports missing git from PATH', () => {
  assert.equal(gitAvailable({ env: { ...process.env, PATH: tempDir('cockpit-empty-path-') } }), false);
});

test('identityConfigured reports missing isolated identity when git exists', { skip: !gitAvailable() }, () => {
  const root = tempDir('cockpit-git-root-');
  const home = tempDir('cockpit-git-home-');
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'missing-global-config'),
  };
  assert.equal(identityConfigured(root, { env }), false);
});

test('initAndCommit fails clearly when git is missing', () => {
  const root = tempDir('cockpit-git-missing-');
  assert.throws(
    () => initAndCommit(root, 'chore: initialize cockpit knowledge repo', { env: { ...process.env, PATH: tempDir('cockpit-empty-path-') }, retryMs: 1 }),
    /git is not available on PATH/,
  );
});

test('initAndCommit fails clearly when identity is missing', { skip: !gitAvailable() }, () => {
  const root = tempDir('cockpit-git-identity-');
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n');
  const home = tempDir('cockpit-git-no-identity-home-');
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'missing-global-config'),
  };
  assert.throws(
    () => initAndCommit(root, 'chore: initialize cockpit knowledge repo', { env, retryMs: 1 }),
    /git identity is not configured/,
  );
});

function gitEnvWithIdentity() {
  const home = tempDir('cockpit-git-identity-home-');
  const globalConfig = path.join(home, '.gitconfig');
  fs.writeFileSync(globalConfig, '[user]\n\tname = Cockpit Test\n\temail = cockpit-test@example.invalid\n', 'utf8');
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
  };
}

test('initAndCommit initializes git and creates the first commit by default', { skip: !gitAvailable() }, () => {
  const root = tempDir('cockpit-git-success-');
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n', 'utf8');
  const result = initAndCommit(root, 'chore: initialize cockpit knowledge repo', { env: gitEnvWithIdentity(), retryMs: 1 });

  assert.deepEqual(result, { committed: true });
  assert.equal(fs.existsSync(path.join(root, '.git')), true);
  assert.equal(fs.existsSync(path.join(root, '.git', 'index')), true);
});

test('initAndCommit retries index.lock contention once then succeeds', { skip: !gitAvailable() }, () => {
  const root = tempDir('cockpit-git-lock-retry-');
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n', 'utf8');
  const env = gitEnvWithIdentity();
  const init = initAndCommit(root, 'chore: initialize cockpit knowledge repo', { env, retryMs: 1 });
  assert.equal(init.committed, true);

  const lock = path.join(root, '.git', 'index.lock');
  fs.writeFileSync(lock, '', 'utf8');
  fs.writeFileSync(path.join(root, 'second.md'), '# Second\n', 'utf8');

  // Clear the lock inside the retry backoff so the second attempt succeeds.
  const result = initAndCommit(root, 'chore: second commit', {
    env,
    retryMs: 1,
    sleep: () => fs.rmSync(lock, { force: true }),
  });
  assert.deepEqual(result, { committed: true, retried: true });
});

test('initAndCommit retries index.lock contention once then fails clearly', { skip: !gitAvailable() }, () => {
  const root = tempDir('cockpit-git-lock-');
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n', 'utf8');
  const init = initAndCommit(root, 'chore: initialize cockpit knowledge repo', { env: gitEnvWithIdentity(), retryMs: 1 });
  assert.equal(init.committed, true);
  fs.writeFileSync(path.join(root, '.git', 'index.lock'), '', 'utf8');
  fs.writeFileSync(path.join(root, 'second.md'), '# Second\n', 'utf8');

  assert.throws(
    () => initAndCommit(root, 'chore: second commit', { env: gitEnvWithIdentity(), retryMs: 1 }),
    /index\.lock contention persisted/,
  );
});
