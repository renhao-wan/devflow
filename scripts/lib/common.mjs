import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const posix = (p) => p.split(sep).join('/');

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  return metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readText(file) {
  return readFileSync(file, 'utf8');
}

export function writeText(file, text) {
  ensureDir(dirname(file));
  writeFileSync(file, text, 'utf8');
}

/** 先写临时文件再替换，避免半成品。 */
export function writeAtomic(file, text) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function walk(dir, suffix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, suffix));
    else if (!suffix || entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

export function findUp(start, relativePath) {
  let cur = resolve(start);
  while (true) {
    const candidate = join(cur, relativePath);
    if (existsSync(candidate)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function projectRoot(start = process.cwd()) {
  return findUp(start, join('.claude', 'hub', 'hub.yaml')) || resolve(start);
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  let key = null;
  let buf = [];
  const flush = () => {
    if (key) out[key] = buf.join(' ').trim();
    key = null;
    buf = [];
  };
  for (const raw of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (km) {
      flush();
      key = km[1];
      const v = km[2].trim().replace(/^[>|][-+]?$/, '').trim();
      buf = v ? [v] : [];
    } else if (key) {
      buf.push(raw.trim());
    }
  }
  flush();
  for (const k of Object.keys(out)) {
    let v = out[k];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/** 去掉行内注释：仅当 # 位于引号外且前一字符是空白（或行首）时才算注释起点。 */
function stripYamlComment(line) {
  let quote = null;
  for (let k = 0; k < line.length; k += 1) {
    const ch = line[k];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (k === 0 || /\s/.test(line[k - 1]))) {
      return line.slice(0, k);
    }
  }
  return line;
}

/**
 * 极简 YAML 子集解析器：支持注释、嵌套 map、块列表、行内 [a, b]、标量。
 * 不追求完整 YAML；doctor 会提示无法解析的行。
 */
export function parseYaml(text) {
  const raw = text.split(/\r?\n/);
  const lines = [];
  for (let n = 0; n < raw.length; n += 1) {
    const line = stripYamlComment(raw[n]);
    if (!line.trim()) continue;
    const indent = /^ */.exec(line)[0].length;
    const body = line.slice(indent).replace(/\s+$/, '');
    if (!body) continue;
    lines.push({ indent, text: body, line: n + 1 });
  }

  let i = 0;
  function parseBlock(indent) {
    if (i >= lines.length) return null;
    if (lines[i].text.startsWith('- ')) return parseList(indent);
    return parseMap(indent);
  }

  function parseMap(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const { text, line } = lines[i];
      const m = /^([^:]+):\s*(.*)$/.exec(text);
      if (!m) throw new Error(`YAML 第 ${line} 行无法解析：${text}`);
      const key = unquote(m[1].trim());
      const rest = m[2].trim();
      i += 1;
      if (rest === '') {
        if (i < lines.length && lines[i].indent > indent) {
          obj[key] = parseBlock(lines[i].indent);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  function parseList(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const item = lines[i].text.slice(2).trim();
      if (/^[A-Za-z0-9_.-]+\s*:/.test(item) && !item.startsWith('"') && !item.startsWith("'")) {
        lines[i] = { ...lines[i], indent: indent + 2, text: item };
        arr.push(parseMap(indent + 2));
      } else {
        arr.push(parseScalar(item));
        i += 1;
      }
    }
    return arr;
  }

  const value = parseBlock(lines.length ? lines[0].indent : 0);
  return value ?? {};
}

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseScalar(v) {
  const s = unquote(v.trim());
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const body = s.slice(1, -1).trim();
    if (!body) return [];
    return body.split(',').map((x) => parseScalar(x.trim()));
  }
  if (s === '{}') return {};
  if (s.startsWith('{') && s.endsWith('}')) {
    const body = s.slice(1, -1).trim();
    if (!body) return {};
    const obj = {};
    for (const pair of body.split(',')) {
      const idx = pair.indexOf(':');
      if (idx < 0) continue;
      obj[pair.slice(0, idx).trim()] = parseScalar(pair.slice(idx + 1).trim());
    }
    return obj;
  }
  return s;
}

export function loadHub(root) {
  const file = join(root, '.claude', 'hub', 'hub.yaml');
  if (!existsSync(file)) throw new Error(`找不到 hub 配置：${posix(file)}`);
  return { file, config: parseYaml(readText(file)) };
}

export function pluginInfo(pluginRoot) {
  const file = join(pluginRoot, '.claude-plugin', 'plugin.json');
  if (!existsSync(file)) throw new Error(`找不到插件元数据：${posix(file)}`);
  return JSON.parse(readText(file));
}

export function readMeta(start) {
  const file = join(start, '.devflow.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

export function isValidPluginRoot(dir) {
  return !!dir && existsSync(join(dir, '.claude-plugin', 'plugin.json'));
}

/** Claude Code 把插件安装到 plugins/cache/<marketplace>/<plugin>/<version>，插件升级后旧目录会失效。 */
export function isPluginCache(dir) {
  return /[\\/]plugins[\\/]cache[\\/]/i.test(String(dir));
}

export function findPluginRoot(start) {
  const meta = readMeta(start);
  const envRoot = isValidPluginRoot(process.env.CLAUDE_PLUGIN_ROOT)
    ? process.env.CLAUDE_PLUGIN_ROOT
    : null;

  if (meta?.pluginRoot && isValidPluginRoot(meta.pluginRoot)) {
    // 记录的缓存路径可能属于刚被替换掉的旧版本，当前会话的插件根更可信
    if (isPluginCache(meta.pluginRoot) && envRoot) return envRoot;
    return meta.pluginRoot;
  }
  if (envRoot) return envRoot;

  const marker = findUp(start, join('.claude-plugin', 'plugin.json'));
  if (marker) return marker;
  throw new Error('找不到 devflow 插件目录。请先执行 /devflow:init，或在插件目录内运行。');
}

/** 回灌目标：显式参数 > .devflow.json 的 pluginSourceRoot > 运行时插件根。 */
export function resolveUpstreamRoot(root, explicit = null) {
  if (explicit) return explicit;
  const meta = readMeta(root);
  if (meta?.pluginSourceRoot && isValidPluginRoot(meta.pluginSourceRoot)) {
    return meta.pluginSourceRoot;
  }
  return findPluginRoot(root);
}

export function cacheGuardMessage(pluginRoot) {
  return [
    `回灌目标落在安装缓存：${posix(pluginRoot)}。`,
    '缓存会在插件升级时被覆盖，回灌结果不会进入仓库。',
    '请用 --plugin-root <插件源码仓库> 指定目标，或运行 /devflow:init --source-root <插件源码仓库> 记录一次。',
  ].join('\n');
}

/** 简化 semver：支持 ^x.y.z、~x.y.z、>=x.y.z、x.y.z、* */
export function satisfies(version, range) {
  if (!range || range === '*') return true;
  const v = version.split('.').map(Number);
  const cmp = (a, b) => {
    for (let k = 0; k < 3; k += 1) {
      if ((a[k] || 0) !== (b[k] || 0)) return (a[k] || 0) - (b[k] || 0);
    }
    return 0;
  };
  for (const part of String(range).split(/\s+/).filter(Boolean)) {
    const m = /^(\^|~|>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(part);
    if (!m) throw new Error(`无法识别的版本范围：${part}`);
    const [, op = '=', major, minor, patch] = m;
    const r = [Number(major), Number(minor), Number(patch)];
    const c = cmp(v, r);
    if (op === '^') {
      if (c < 0) return false;
      // 按 semver：^1.2.3 允许 <2.0.0；^0.2.3 允许 <0.3.0；^0.0.3 只允许 0.0.3
      if (r[0] > 0) {
        if (v[0] !== r[0]) return false;
      } else if (r[1] > 0) {
        if (v[0] !== 0 || v[1] !== r[1]) return false;
      } else if (v[0] !== 0 || v[1] !== 0 || v[2] !== r[2]) {
        return false;
      }
    } else if (op === '~') {
      if (c < 0 || v[0] !== r[0] || v[1] !== r[1]) return false;
    } else if (op === '>=' && c < 0) return false;
    else if (op === '<=' && c > 0) return false;
    else if (op === '>' && c <= 0) return false;
    else if (op === '<' && c >= 0) return false;
    else if (op === '=' && c !== 0) return false;
  }
  return true;
}

export function bumpPatch(version) {
  const [a, b, c] = version.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

export function argValue(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] ?? fallback;
}

export function hasFlag(argv, name) {
  return argv.includes(name);
}

export function log(status, message) {
  const tag = status === 'ok' ? '[OK]  ' : status === 'warn' ? '[WARN]' : status === 'error' ? '[ERR] ' : '[..]  ';
  console.log(`${tag} ${message}`);
}

export function relPosix(from, to) {
  return posix(relative(from, to));
}

export function removeDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function isDir(p) {
  return existsSync(p) && statSync(p).isDirectory();
}
