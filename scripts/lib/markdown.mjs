// 任务产物（Markdown）的确定性解析工具：只认小节标题、列表与表格，
// 不做语义理解，供阶段门禁与状态视图共用。

/** 读取指定 `## 标题` 的正文；不存在时返回 null。 */
export function section(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    return m && m[1] === title;
  });
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** 读取 `- 字段：值` 形式的行；值可换成下一行起的缩进子条目。 */
export function bulletValue(body, label) {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].replace(/^\s*[-*]\s+/, '').trim();
    if (!stripped.startsWith(label)) continue;
    // 标签后可能跟括号说明或补充文字，统一取到第一个冒号为止。
    const rest = stripped.slice(label.length);
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
  return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
}

/** 返回表格首行（表头）的单元格；没有表格时返回 null。 */
export function tableHeader(body) {
  if (!body) return null;
  const row = body.split(/\r?\n/).find((line) => /^\s*\|/.test(line));
  return row ? splitRow(row) : null;
}

/** 解析 Markdown 表格的数据行（跳过表头与分隔行），返回单元格数组。 */
export function tableRows(body) {
  if (!body) return [];
  const rows = body.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
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
    .map((line) => /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ checked: m[1].toLowerCase() === 'x', text: m[2].trim() }));
}

/** 模板原样保留的选项行（例如 `low / medium / high / special`）视为未填写。 */
export function isOptionPlaceholder(value, options) {
  const hits = options.filter((option) => {
    const escaped = String(option).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b 只对 ASCII 单词字符有效，中文选项按子串匹配。
    const pattern = /^[A-Za-z0-9_-]+$/.test(option) ? `\\b${escaped}\\b` : escaped;
    return new RegExp(pattern, 'i').test(value);
  }).length;
  return hits >= Math.min(3, options.length);
}

/** 去掉模板中的 `...` 占位；返回有意义的内容。 */
export function meaningful(text) {
  return String(text || '').replace(/\.{3,}/g, '').replace(/（[^）]*）|\([^)]*\)/g, '').trim();
}
