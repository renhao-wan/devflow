// 任务 slug 解析：review-triage 与 stage-check 共用，保证同一套候选与歧义规则。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isRealPathInside } from './common.mjs';

export const MISSING = Symbol('missing');

/** 决定一个目录是否算任务入口的产物；hub-status 与 slug 解析共用同一口径。 */
export const ENTRY_ARTIFACTS = ['req.md', 'plan.md', 'brief.md', 'debug.md'];

export function isTaskDir(dir) {
  return ENTRY_ARTIFACTS.some((file) => existsSync(join(dir, file)));
}

export function validSlug(slug) {
  if (typeof slug !== 'string' || !slug || slug.length > 80) return false;
  // 尾随空格、隐藏目录、`.`/`..` 与路径分隔符都不能作为任务名。
  if (slug.trim() !== slug || slug.startsWith('.')) return false;
  if (slug.includes('..') || /[\\/]/.test(slug)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug);
}

export function listCandidates(root) {
  const docs = join(root, 'docs', 'devflow');
  if (!existsSync(docs)) return [];
  return readdirSync(docs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    // 只有 test.md/review.md 的目录不是可解析的任务，扫描与解析必须一致。
    .filter((name) => isTaskDir(join(docs, name)));
}

/** 显式 slug 不存在时返回 MISSING；未指定且候选不唯一时抛错。 */
export function resolveSlug(root, wanted) {
  if (wanted) {
    if (!validSlug(wanted)) throw new Error(`非法的 slug：${wanted}`);
    const dir = join(root, 'docs', 'devflow', wanted);
    if (!existsSync(dir)) return MISSING;
    // slug 目录可能是指向项目外的符号链接/junction，读取产物前必须校验真实路径。
    if (!isRealPathInside(root, dir)) throw new Error(`slug 目录越界：${wanted}`);
    return wanted;
  }
  const candidates = listCandidates(root);
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) {
    throw new Error('未发现任务；先运行 /devflow:req、/devflow:debug 或指定 --slug');
  }
  throw new Error(`存在多个任务，请指定 --slug：${candidates.join('、')}`);
}
