import { spawnSync } from 'node:child_process';

const indexLockPattern = /index\.lock|Unable to create .*\.git\/index\.lock|File exists/i;

function runGit(root, args, { env = process.env } = {}) {
  return spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
}

function gitOk(result) {
  return !result.error && result.status === 0;
}

export function gitAvailable({ env = process.env } = {}) {
  const result = spawnSync('git', ['--version'], { env, encoding: 'utf8' });
  return gitOk(result);
}

export function identityConfigured(root, { env = process.env } = {}) {
  const name = runGit(root, ['config', '--get', 'user.name'], { env });
  const email = runGit(root, ['config', '--get', 'user.email'], { env });
  return gitOk(name) && name.stdout.trim() !== '' && gitOk(email) && email.stdout.trim() !== '';
}

function sleep(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function clearFailure(result) {
  if (result.error) return result.error.message;
  return `${result.stderr || result.stdout || `git exited with status ${result.status}`}`.trim();
}

function commitOnce(root, message, options) {
  const init = runGit(root, ['init'], options);
  if (!gitOk(init)) throw new Error(`git init failed in ${root}: ${clearFailure(init)}`);

  const add = runGit(root, ['add', '-A'], options);
  if (!gitOk(add)) throw new Error(`git add failed in ${root}: ${clearFailure(add)}`);

  const commit = runGit(root, ['commit', '-m', message], options);
  if (!gitOk(commit)) throw new Error(`git commit failed in ${root}: ${clearFailure(commit)}`);
}

export function initAndCommit(root, message, { env = process.env, retryMs = 500, sleep: sleepFn = sleep } = {}) {
  if (!gitAvailable({ env })) throw new Error('git is not available on PATH. Install git or rerun setup with --no-git.');
  if (!identityConfigured(root, { env })) {
    throw new Error('git identity is not configured. Run: git config --global user.name "Your Name" and git config --global user.email "you@example.com", then retry.');
  }

  try {
    commitOnce(root, message, { env });
    return { committed: true };
  } catch (error) {
    if (!indexLockPattern.test(error.message)) throw error;
    sleepFn(retryMs);
  }

  try {
    commitOnce(root, message, { env });
    return { committed: true, retried: true };
  } catch (error) {
    if (indexLockPattern.test(error.message)) throw new Error(`git index.lock contention persisted in ${root} after one retry; close other git processes and retry.`);
    throw error;
  }
}
