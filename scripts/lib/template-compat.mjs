import { parseFrontmatter, satisfies } from './common.mjs';

const LOADER_REF = /scripts\/devflow-[a-z0-9-]+\.mjs/gi;

/** 模板正文引用的项目内 loader 文件名。 */
export function referencedLoaders(text) {
  const out = new Set();
  for (const match of String(text).matchAll(LOADER_REF)) {
    out.add(match[0].replace(/^scripts\//, ''));
  }
  return out;
}

/**
 * 模板与当前插件的兼容性问题（按严重程度分级）：
 * - error：引用了插件未提供的 loader，同步到项目后会断链；
 * - warn：`minPluginVersion`（无操作符时按 >= 处理）高于当前插件。
 */
export function templateIssues(text, { loaderFiles = null, pluginVersion = null } = {}) {
  const issues = [];
  if (loaderFiles) {
    for (const name of referencedLoaders(text)) {
      if (!loaderFiles.has(name)) {
        issues.push({ severity: 'error', message: `引用了当前插件未提供的 loader：scripts/${name}` });
      }
    }
  }
  if (pluginVersion) {
    const min = parseFrontmatter(text).minPluginVersion;
    if (min) {
      const raw = String(min).trim();
      const range = /^[<>=^~]/.test(raw) ? raw : `>=${raw}`;
      try {
        if (!satisfies(pluginVersion, range)) {
          issues.push({ severity: 'warn', message: `要求插件 ${range}，当前为 ${pluginVersion}` });
        }
      } catch (err) {
        issues.push({ severity: 'warn', message: `minPluginVersion 无法解析（${raw}）：${err.message}` });
      }
    }
  }
  return issues;
}
