import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-review-'));
  fs.mkdirSync(path.join(root, '.cockpit'));
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

import { tryAcquire, readLock, releaseLock } from '../skill/lib/lock.mjs';
const script = path.resolve(import.meta.dirname, '../skill/scripts/lock.mjs');

test('same-holder stale restart gets fresh ownership, PID and token', (t) => {
  const root = rootFor(t);
  const first = tryAcquire(root, { holder: 'writer', pidBound: true, pid: 123, host: 'test-host', now: () => 1000 });
  const second = tryAcquire(root, { holder: 'writer', pidBound: true, pid: 456, host: 'test-host', pidAlive: () => false, now: () => 2000 });
  assert.ok(second.acquired && second.takeover && !second.renewed);
  assert.equal(second.lock.pid, 456);
  assert.notEqual(second.lock.token, first.lock.token);
  assert.equal(tryAcquire(root, { holder: 'other', host: 'test-host', pidAlive: () => true, now: () => 2001 }).acquired, false);
  releaseLock(root, { force: true });
  const expired = tryAcquire(root, { holder: 'writer', ttlMs: 1, now: () => 1000 });
  const fresh = tryAcquire(root, { holder: 'writer', now: () => 2000 });
  assert.ok(fresh.takeover && !fresh.renewed);
  assert.notEqual(fresh.lock.token, expired.lock.token);
});

test('same-holder restarted run releases the stale record it replaced', async (t) => {
  const root = rootFor(t);
  tryAcquire(root, { holder: 'writer', ttlMs: 1, now: () => 0 });
  const child = spawn(process.execPath, [script, 'run', '--root', root, '--holder', 'writer', '--', process.execPath, '-e', 'process.exit(0)']);
  const done = once(child, 'close');
  child.stdout.resume(); child.stderr.resume();
  assert.equal((await done)[0], 0);
  assert.equal(readLock(root), null);
});

test('run signals the shell process group and retains the lock through worker shutdown', { skip: process.platform === 'win32', timeout: 10000 }, async (t) => {
  const root = rootFor(t);
  const ready = path.join(root, 'ready');
  const stopped = path.join(root, 'stopped');
  const worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(worker, `const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(stopped)}, String(fs.existsSync(${JSON.stringify(path.join(root, '.cockpit', 'lock'))})));
      process.exit(0);
    }, 400));
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [script, 'run', '--root', root, '--holder', 'writer', '--', 'sh', '-c', '"$1" "$2" & wait', 'sh', process.execPath, worker]);
  const done = once(child, 'close');
  let output = ''; child.stderr.on('data', (chunk) => { output += chunk; }); child.stdout.resume();
  t.after(() => { try { child.kill('SIGTERM'); } catch {} });
  await until(() => fs.existsSync(ready));
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(readLock(root), output);
  assert.equal(tryAcquire(root, { holder: 'other' }).acquired, false);
  assert.equal((await done)[0], 143, output);
  assert.equal(fs.readFileSync(stopped, 'utf8'), 'true');
  assert.equal(readLock(root), null);
});
