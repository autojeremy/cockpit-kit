import fs from 'node:fs';
import path from 'node:path';
import { parseToml, stringifyToml } from './toml.mjs';
import { configPath as getConfigPath, expandHome } from './paths.mjs';

export class RootResolutionError extends Error {
  constructor(message, { configPath } = {}) {
    super(message);
    this.name = 'RootResolutionError';
    this.configPath = configPath;
  }
}

export class CockpitRootValidationError extends Error {
  constructor(message, { root } = {}) {
    super(message);
    this.name = 'CockpitRootValidationError';
    this.root = root;
  }
}

export class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgumentError';
  }
}

function requireEnv(env, caller) {
  if (!env) throw new Error(`${caller} requires an explicit env object`);
}

function absoluteExpanded(input, env) {
  return path.resolve(expandHome(input, env));
}

export function parseRootArg(argv = []) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--cockpit-root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new ArgumentError(`${arg} requires a path argument`);
      return value;
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value) throw new ArgumentError('--root requires a path argument');
      return value;
    }
    if (arg.startsWith('--cockpit-root=')) {
      const value = arg.slice('--cockpit-root='.length);
      if (!value) throw new ArgumentError('--cockpit-root requires a path argument');
      return value;
    }
  }
  return undefined;
}

export function readConfig(env) {
  requireEnv(env, 'readConfig');
  const pathToConfig = getConfigPath(env);
  if (!fs.existsSync(pathToConfig)) return { ok: false, reason: 'missing_config', configPath: pathToConfig, values: {} };
  const values = parseToml(fs.readFileSync(pathToConfig, 'utf8'));
  return {
    ok: true,
    configPath: pathToConfig,
    values,
    cockpitRoot: typeof values.cockpit_root === 'string' ? values.cockpit_root : undefined,
    skillRoot: typeof values.skill_root === 'string' ? values.skill_root : undefined,
  };
}

export function writeConfig(env, updates) {
  requireEnv(env, 'writeConfig');
  const pathToConfig = getConfigPath(env);
  let values = {};
  if (fs.existsSync(pathToConfig)) values = parseToml(fs.readFileSync(pathToConfig, 'utf8'));
  const next = { ...values, ...updates };
  fs.mkdirSync(path.dirname(pathToConfig), { recursive: true });
  fs.writeFileSync(pathToConfig, stringifyToml(next), 'utf8');
  return { configPath: pathToConfig, values: next };
}

export function validateCockpitRoot(root) {
  const resolved = path.resolve(root);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new CockpitRootValidationError(`Cockpit root does not exist: ${resolved}`, { root: resolved });
  }
  if (!stat.isDirectory()) throw new CockpitRootValidationError(`Cockpit root is not a directory: ${resolved}`, { root: resolved });

  const cockpitDir = path.join(resolved, '.cockpit');
  try {
    if (!fs.statSync(cockpitDir).isDirectory()) throw new CockpitRootValidationError(`Cockpit root marker is not a directory: ${cockpitDir}`, { root: resolved });
  } catch (error) {
    if (error instanceof CockpitRootValidationError) throw error;
    throw new CockpitRootValidationError(`Cockpit root is missing .cockpit/: ${cockpitDir}`, { root: resolved });
  }

  const sources = path.join(cockpitDir, 'sources.toml');
  try {
    if (!fs.statSync(sources).isFile()) throw new CockpitRootValidationError(`Cockpit root sources manifest is not a file: ${sources}`, { root: resolved });
  } catch (error) {
    if (error instanceof CockpitRootValidationError) throw error;
    throw new CockpitRootValidationError(`Cockpit root is missing required manifest: ${sources}`, { root: resolved });
  }
  return { root: resolved, cockpitDir, sources };
}

export function resolveRoot({ argv = [], env, forWrite = false, stderr } = {}) {
  requireEnv(env, 'resolveRoot');
  const pathToConfig = getConfigPath(env);
  const config = readConfig(env);
  const argRoot = parseRootArg(argv);
  let source;
  let rawRoot;

  if (argRoot) {
    source = 'arg';
    rawRoot = argRoot;
  } else if (env.COCKPIT_HOME) {
    source = 'env';
    rawRoot = env.COCKPIT_HOME;
  } else if (config.ok && config.cockpitRoot) {
    source = 'config';
    rawRoot = config.cockpitRoot;
  }

  if (!rawRoot) {
    throw new RootResolutionError(
      `No Cockpit root configured. Run: node <cockpit-kit>/scripts/link.mjs <path> or node <cockpit-kit>/scripts/setup.mjs --cockpit-root <path>. Looked for config at ${pathToConfig}.`,
      { configPath: pathToConfig },
    );
  }

  const root = absoluteExpanded(rawRoot, env);
  if (source === 'env' && config.ok && config.cockpitRoot) {
    const configRoot = absoluteExpanded(config.cockpitRoot, env);
    if (configRoot !== root && stderr && typeof stderr.write === 'function') stderr.write(`Warning: COCKPIT_HOME (${root}) overrides config cockpit_root (${configRoot}).\n`);
  }
  if (forWrite) validateCockpitRoot(root);
  return { root, source, configPath: pathToConfig, cockpitRoot: root, skillRoot: config.skillRoot };
}
