export class TomlParseError extends Error {
  constructor(message, line) {
    super(`TOML parse error on line ${line}: ${message}`);
    this.name = 'TomlParseError';
    this.line = line;
  }
}

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;
const ARRAY_TABLES = new WeakSet();

function fail(line, message) {
  throw new TomlParseError(message, line);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateBareKey(key, line, context = 'key') {
  if (!BARE_KEY_RE.test(key)) fail(line, `unsupported ${context} ${JSON.stringify(key)}`);
}

function stripComment(raw) {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '#') return raw.slice(0, i);
  }
  return raw;
}

function findEquals(line) {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '=') return i;
  }
  return -1;
}

function parseBasicString(raw, line) {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) fail(line, 'expected a basic double-quoted string');
  let out = '';
  for (let i = 1; i < raw.length - 1; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      if (ch === '"') fail(line, 'unescaped quote in string');
      out += ch;
      continue;
    }
    i += 1;
    if (i >= raw.length - 1) fail(line, 'unfinished escape sequence in string');
    const esc = raw[i];
    if (esc === '\\') out += '\\';
    else if (esc === '"') out += '"';
    else if (esc === 'n') out += '\n';
    else if (esc === 't') out += '\t';
    else fail(line, `unsupported string escape \\${esc}`);
  }
  return out;
}

function parseStringArray(raw, line) {
  if (!raw.endsWith(']')) fail(line, 'unterminated array');
  const values = [];
  let i = 1;
  const skipWs = () => { while (i < raw.length - 1 && /\s/.test(raw[i])) i += 1; };
  skipWs();
  if (raw[i] === ']') return values;
  while (i < raw.length - 1) {
    skipWs();
    if (raw[i] !== '"') fail(line, 'only arrays of strings are supported');
    const start = i;
    i += 1;
    let escaped = false;
    while (i < raw.length) {
      const ch = raw[i];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') { i += 1; break; }
      i += 1;
    }
    if (i > raw.length || raw[i - 1] !== '"') fail(line, 'unterminated string in array');
    values.push(parseBasicString(raw.slice(start, i), line));
    skipWs();
    if (raw[i] === ',') {
      i += 1;
      skipWs();
      if (raw[i] === ']') fail(line, 'trailing commas are not supported');
      continue;
    }
    if (raw[i] === ']') break;
    fail(line, 'expected comma or closing bracket in array');
  }
  return values;
}

function parseValue(raw, line) {
  if (raw.startsWith('"')) return parseBasicString(raw, line);
  if (raw.startsWith("'")) fail(line, 'literal strings are not supported');
  if (raw.startsWith('[')) {
    if (raw.startsWith('[[')) fail(line, 'nested arrays are not supported');
    return parseStringArray(raw, line);
  }
  if (raw.startsWith('{')) fail(line, 'inline tables are not supported');
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^[+-]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^[+-]?\d+\.\d+/.test(raw)) fail(line, 'floats are not supported');
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) fail(line, 'dates are not supported');
  fail(line, `unsupported value ${JSON.stringify(raw)}`);
}

function markKey(seenKeys, table, key, line) {
  let keys = seenKeys.get(table);
  if (!keys) {
    keys = new Set();
    seenKeys.set(table, keys);
  }
  if (keys.has(key)) fail(line, `duplicate key ${key}`);
  keys.add(key);
}

export function parseToml(text) {
  const root = {};
  const seenKeys = new WeakMap();
  const declaredTables = new Set();
  let current = root;
  const lines = String(text ?? '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (line === '') continue;

    if (line.startsWith('[[') || line.startsWith('[')) {
      const isArrayTable = line.startsWith('[[');
      const close = isArrayTable ? ']]' : ']';
      if (!line.endsWith(close)) fail(lineNumber, 'malformed table header');
      const name = line.slice(isArrayTable ? 2 : 1, isArrayTable ? -2 : -1).trim();
      if (name === '') fail(lineNumber, 'empty table header');
      const parts = name.split('.');

      if (isArrayTable) {
        if (parts.length !== 1) fail(lineNumber, 'arrays of tables with dotted names are not supported');
        const key = parts[0];
        validateBareKey(key, lineNumber, 'array table name');
        if (root[key] === undefined) {
          root[key] = [];
          ARRAY_TABLES.add(root[key]);
        } else if (!Array.isArray(root[key]) || !ARRAY_TABLES.has(root[key])) {
          fail(lineNumber, `type change for ${key}: expected array of tables`);
        }
        current = {};
        root[key].push(current);
        continue;
      }

      if (parts.length > 2) fail(lineNumber, 'table headers deeper than two segments are not supported');
      for (const part of parts) validateBareKey(part, lineNumber, 'table name');
      const tablePath = parts.join('.');
      if (declaredTables.has(tablePath)) fail(lineNumber, `duplicate table ${tablePath}`);
      declaredTables.add(tablePath);

      if (parts.length === 1) {
        const key = parts[0];
        if (root[key] === undefined) root[key] = {};
        else if (!isPlainObject(root[key])) fail(lineNumber, `type change for ${key}: expected table`);
        current = root[key];
      } else {
        const [parentKey, childKey] = parts;
        if (root[parentKey] === undefined) root[parentKey] = {};
        else if (!isPlainObject(root[parentKey])) fail(lineNumber, `type change for ${parentKey}: expected table`);
        const parent = root[parentKey];
        if (parent[childKey] === undefined) parent[childKey] = {};
        else if (!isPlainObject(parent[childKey])) fail(lineNumber, `type change for ${tablePath}: expected table`);
        else if (Object.keys(parent[childKey]).length > 0) fail(lineNumber, `duplicate table ${tablePath}`);
        current = parent[childKey];
      }
      continue;
    }

    const equals = findEquals(line);
    if (equals === -1) fail(lineNumber, 'expected key/value pair');
    const key = line.slice(0, equals).trim();
    const valueText = line.slice(equals + 1).trim();
    if (key.includes('.')) fail(lineNumber, 'dotted keys are not supported');
    validateBareKey(key, lineNumber);
    if (valueText === '') fail(lineNumber, `missing value for ${key}`);
    markKey(seenKeys, current, key, lineNumber);
    if (current[key] !== undefined) fail(lineNumber, `duplicate key ${key}`);
    current[key] = parseValue(valueText, lineNumber);
  }

  return root;
}

function quoteString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

function formatValue(value) {
  if (typeof value === 'string') return quoteString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Number.isInteger(value)) return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return `[${value.map(quoteString).join(', ')}]`;
  throw new TypeError(`unsupported TOML value type for ${JSON.stringify(value)}`);
}

export function stringifyToml(data, { header = '# Generated by Cockpit Kit. Comments may be rewritten.\n' } = {}) {
  if (!isPlainObject(data)) throw new TypeError('TOML root must be an object');
  const lines = [];
  if (header) {
    for (const line of header.replace(/\n+$/, '').split('\n')) lines.push(line);
    lines.push('');
  }
  const entries = Object.entries(data);

  for (const [key, value] of entries) {
    validateBareKey(key, 0);
    if (!isPlainObject(value) && !(Array.isArray(value) && value.every(isPlainObject))) lines.push(`${key} = ${formatValue(value)}`);
  }

  for (const [key, value] of entries) {
    if (!Array.isArray(value) || !value.every(isPlainObject)) continue;
    for (const item of value) {
      if (lines.at(-1) !== '') lines.push('');
      lines.push(`[[${key}]]`);
      for (const [childKey, childValue] of Object.entries(item)) {
        validateBareKey(childKey, 0);
        lines.push(`${childKey} = ${formatValue(childValue)}`);
      }
    }
  }

  for (const [key, value] of entries) {
    if (!isPlainObject(value)) continue;
    const nested = Object.entries(value);
    for (const [childKey, childValue] of nested) {
      if (Array.isArray(childValue) && childValue.length > 0 && childValue.every(isPlainObject)) {
        throw new TypeError(`unsupported nested TOML structure under ${key}.${childKey}`);
      }
    }
    const scalarChildren = nested.filter(([, childValue]) => !isPlainObject(childValue));
    if (scalarChildren.length > 0) {
      if (lines.at(-1) !== '') lines.push('');
      lines.push(`[${key}]`);
      for (const [childKey, childValue] of scalarChildren) {
        validateBareKey(childKey, 0);
        lines.push(`${childKey} = ${formatValue(childValue)}`);
      }
    }
    for (const [childKey, childValue] of nested) {
      if (!isPlainObject(childValue)) continue;
      if (lines.at(-1) !== '') lines.push('');
      validateBareKey(childKey, 0);
      lines.push(`[${key}.${childKey}]`);
      for (const [grandKey, grandValue] of Object.entries(childValue)) {
        validateBareKey(grandKey, 0);
        lines.push(`${grandKey} = ${formatValue(grandValue)}`);
      }
    }
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
