import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function expandHome(input, env = process.env) {
  if (typeof input !== 'string') return input;
  if (input === '~' || input.startsWith('~/')) {
    if (!env.HOME) throw new Error('HOME is not set; cannot expand ~');
    return path.join(env.HOME, input.slice(input === '~' ? 1 : 2));
  }
  return input;
}

export function configPath(env) {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ''
    ? expandHome(env.XDG_CONFIG_HOME, env)
    : path.join(expandHome('~', env), '.config');
  return path.join(path.resolve(configHome), 'cockpit', 'config.toml');
}

export function kitRoot(importMetaUrl) {
  const filePath = fs.realpathSync.native(fileURLToPath(importMetaUrl));
  const dir = path.dirname(filePath);
  const base = path.basename(dir);
  const root = base === 'scripts' || base === 'lib' ? path.dirname(dir) : dir;
  return fs.realpathSync.native(root);
}

function realpathClosest(inputPath) {
  const absolute = path.resolve(inputPath);
  const missing = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const real = fs.realpathSync.native(cursor);
  return path.join(real, ...missing);
}

export function isPathInside(child, parent) {
  const childReal = realpathClosest(child);
  const parentReal = realpathClosest(parent);
  const relative = path.relative(parentReal, childReal);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function assertNode20(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`Cockpit Kit requires Node.js 20 or newer. Current version: ${version || 'unknown'}. Upgrade Node and retry.`);
  }
}
