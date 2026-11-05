// 计划漂移：把 plan.md / brief.md 里声明的文件与实际 git 改动对照，
// 只提示“计划了没改”和“改了没计划”，不改变阶段或门禁判定。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from './common.mjs';
import { section, tableHeader, tableRows } from './markdown.mjs';
import { collectChanges } from './review.mjs';

// 测试、文档、生成物与流程产物不属于实现范围，比较时一律忽略。
const IGNORED = /^(\.claude|docs\/devflow)(\/|$)|(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$|\.(md|mdx|rst|txt)$|(^|\/)(dist|build|coverage|node_modules)(\/|$)/i;

const COLUMN_HINTS = ['涉及文件', '文件/模块', '文件', '模块'];

function normalize(path) {
  return String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^`|`$/g, '');
}

/** 比较键：去掉目录尾斜杠并统一小写，避免大小写或 `src/` 写法造成误报。 */
function pathKey(path) {
  return normalize(path).replace(/\/+$/, '').toLowerCase();
}

function planTable(root, slug) {
  const dir = join(root, 'docs', 'devflow', slug);
  const candidates = [
    ['plan.md', '任务拆分'],
    ['brief.md', '改动范围与测试计划'],
  ];
  for (const [name, title] of candidates) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const body = section(readText(file), title);
    if (body === null) continue;
    const header = tableHeader(body) || [];
    const column = header.findIndex((cell) => COLUMN_HINTS.some((hint) => cell.includes(hint)));
    if (column < 0) continue;
    return { file: name, rows: tableRows(body).map((cells) => cells[column] || '') };
  }
  return null;
}

function pathTokens(cell) {
  return String(cell || '')
    .split(/[、,，;；]+/)
    .flatMap((part) => {
      const whole = normalize(part);
      if (!whole) return [];
      // 以扩展名结尾时优先当作单个路径，避免把“my file.js”拆成两段。
      if (/\.[a-z0-9]{1,8}$/i.test(whole)) return [whole];
      return whole.split(/\s+/).map(normalize).filter(Boolean);
    })
    .filter((token) => token && !IGNORED.test(token))
    // 只认像路径的 token：带 `/` 或带扩展名，避免把一句说明当成文件。
    .filter((token) => token.includes('/') || /\.[a-z0-9]{1,8}$/i.test(token));
}

function covers(planned, path) {
  const p = pathKey(planned);
  const file = pathKey(path);
  if (!p || !file) return false;
  // 计划写目录（`src/` 或 `src`）时，目录下的文件都算已覆盖。
  return p === file || (p.includes('/') && file.startsWith(`${p}/`))
    || (planned.endsWith('/') && file.startsWith(`${p}/`));
}

/**
 * changes 为 collectChanges 的结果；传 null 时自行读取 git。
 * 非 git 或无法统计时返回 skipped，避免把“读不到”误报成漂移。
 */
export function planDriftFor(root, slug, { changes = null } = {}) {
  const table = planTable(root, slug);
  if (!table) {
    return {
      skipped: true,
      reason: '计划产物未列出涉及文件',
      planned: [],
      plannedButUnchanged: [],
      unplannedChanged: [],
      warnings: [],
    };
  }
  const planned = [...new Set(table.rows.flatMap(pathTokens))];
  if (!planned.length) {
    return {
      skipped: true,
      reason: `${table.file} 的涉及文件列没有可比较的路径`,
      planned: [],
      plannedButUnchanged: [],
      unplannedChanged: [],
      warnings: [],
    };
  }

  const actual = changes || collectChanges(root);
  if (!actual.statsAvailable) {
    return {
      skipped: true,
      reason: '无法统计 git 改动，计划漂移判断不完整',
      planned,
      plannedButUnchanged: [],
      unplannedChanged: [],
      warnings: actual.warnings,
    };
  }

  const changed = [...new Set(actual.files
    .map((file) => normalize(file.path))
    .filter((path) => path && !IGNORED.test(path)))];

  const plannedButUnchanged = planned.filter((path) => !changed.some((file) => covers(path, file)));
  const unplannedChanged = changed.filter((file) => !planned.some((path) => covers(path, file)));

  return {
    skipped: false,
    reason: null,
    source: table.file,
    planned,
    plannedButUnchanged,
    unplannedChanged,
    warnings: actual.warnings,
  };
}
