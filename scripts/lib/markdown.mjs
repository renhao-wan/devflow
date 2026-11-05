// 任务产物（Markdown）的确定性解析工具：只认小节标题、列表与表格，
// 不做语义理解，供阶段门禁与状态视图共用。

const HEADING = /^\s{0,3}##\s+(.+?)\s*#*\s*$/;
/** 标题比较键：忽略末尾括号补充，兼容 `## 升级判断（命中硬触发时填写）`。 */
function headingKey(value) {
  return String(value || '').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
}

/** 读取指定 `## 标题` 的正文；不存在时返回 null。标题后的括号说明不影响匹配。 */
export function section(text, title) {
  const lines = String(text ?? '').split(/\r?\n/);
  const wanted = headingKey(title);
  const start = lines.findIndex((line) => {
    const m = HEADING.exec(line);
    return m && headingKey(m[1]) === wanted;
  });
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (HEADING.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** 读取 `- 字段：值` 形式的行；值可换成下一行起的缩进子条目。 */
export function bulletValue(body, label) {
  const lines = String(body ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].replace(/^\s*[-*]\s+/, '').trim();
    if (!stripped.startsWith(label)) continue;
    const rest = stripped.slice(label.length);
    // 标签必须完整：`结论说明：` 不能命中 `结论`。
    if (rest !== '' && !/^\s*[：:(（]/.test(rest)) continue;
    // 标签后可能跟括号说明或补充文字，统一取到第一个冒号为止。
    const colon = rest.search(/[：:]/);
    if (colon < 0) continue;
    let value = rest.slice(colon + 1).trim();
    const parts = [];
    if (!value) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].trim()) break;
        if (!/^\s+/.test(lines[j])) break;
        parts.push(lines[j].replace(/^\s*[-*]\s+/, '').trim());
      }
      value = parts.filter(Boolean).join('；');
    }
    return { found: true, value };
  }
  return { found: false, value: '' };
}

function splitRow(row) {
  return String(row).trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/** 通过围栏标记判断哪些行位于代码块内：代码块里的示例表格不是真实表格。 */
function fencedFlags(lines) {
  const flags = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      flags.push(true);
      fenced = !fenced;
      continue;
    }
    flags.push(fenced);
  }
  return flags;
}

/** 返回表格首行（表头）的单元格；没有表格时返回 null。 */
export function tableHeader(body) {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  const flags = fencedFlags(lines);
  const index = lines.findIndex((line, i) => !flags[i] && /^\s*\|/.test(line));
  if (index < 0) return null;
  return splitRow(lines[index]);
}

/** 解析 Markdown 表格的数据行（跳过表头与分隔行），返回单元格数组。 */
export function tableRows(body) {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const flags = fencedFlags(lines);
  const rows = lines.filter((line, i) => !flags[i] && /^\s*\|/.test(line));
  const out = [];
  // 第一行是表头；其余行只要存在非空单元格就算数据行。
  for (const row of rows.slice(1)) {
    const cells = splitRow(row);
    if (cells.every((cell) => !cell || /^:?-{2,}:?$/.test(cell))) continue;
    out.push(cells);
  }
  return out;
}

export function tableDataRows(body) {
  return tableRows(body).length;
}

/** 返回小节内的复选框：[{ checked, text }]。`- [ ] ...` 这类模板占位也包含在内。 */
export function checkboxes(body) {
  if (!body) return [];
  return body.split(/\r?\n/)
    // CommonMark 允许 `-`、`*`、`+` 三种列表标记，模板与手写常混用。
    .map((line) => /^\s*[-*+]\s*\[([ xX])\]\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ checked: m[1].toLowerCase() === 'x', text: m[2].trim() }));
}

/**
 * 模板原样保留的选项行（例如 `low / medium / high / special`）视为未填写。
 * 只有全部选项出现、且去掉选项、标点与模板说明词后不剩任何内容才算占位；
 * 用户额外写了理由（例如“high：涉及权限模型”）或逐项写明，说明已经做出选择。
 */
const PLACEHOLDER_NOISE = /原因|说明|逐项|写明|可选|例如|比如|子代理|上限|每档|\d+|[已未无不待须]/g;

export function isOptionPlaceholder(value, options) {
  const text = String(value ?? '');
  if (!text.trim()) return true;
  if (!options.length) return false;
  const hits = options.filter((option) => {
    const escaped = String(option).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b 只对 ASCII 单词字符有效，中文选项按子串匹配。
    const pattern = /^[A-Za-z0-9_-]+$/.test(option) ? `\\b${escaped}\\b` : escaped;
    return new RegExp(pattern, 'i').test(text);
  }).length;
  if (hits < options.length) return false;
  let leftover = text;
  for (const option of [...options].sort((a, b) => String(b).length - String(a).length)) {
    const escaped = String(option).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    leftover = leftover.replace(new RegExp(escaped, 'gi'), '');
  }
  // 去掉标点、模板说明词与状态前缀后仍有实义内容，说明用户补充了自己的判断。
  return leftover.replace(PLACEHOLDER_NOISE, '').replace(/[^\p{L}\p{N}]/gu, '').length === 0;
}

/**
 * 去掉模板占位后返回有意义的内容：
 * `...`、HTML 注释、行首的 AC 编号（`AC-1`）以及纯括号说明都不算填写。
 */
export function meaningful(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\.{3,}/g, '')
    .replace(/^\s*(?:[-*+]\s+)?(?:AC|REQ|SC)[-_ ]?\d+[\s、:：.-]*/i, '')
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .trim();
}
