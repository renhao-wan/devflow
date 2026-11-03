// 任务 slug 解析：review-triage 与 stage-check 共用，保证同一套候选与歧义规则。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const MISSING = Symbol('missing');

export function validSlug(slug) {
  return Boolean(slug) && !slug.includes('..') && !/[\\/]/.test(slug);
}

export function listCandidates(root) {
  const docs = join(root, 'docs', 'devflow');
  if (!existsSync(docs)) return [];
  return readdirSync(docs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => ['req.md', 'plan.md', 'brief.md', 'debug.md']
      .some((file) => existsSync(join(docs, name, file))));
}

/** 显式 slug 不存在时返回 MISSING；未指定且候选不唯一时抛错。 */
export function resolveSlug(root, wanted) {
  if (wanted) {
    if (!validSlug(wanted)) throw new Error(`非法的 slug：${wanted}`);
    if (!existsSync(join(root, 'docs', 'devflow', wanted))) return MISSING;
    return wanted;
  }
  const candidates = listCandidates(root);
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) {
    throw new Error('未发现任务；先运行 /devflow:req、/devflow:debug 或指定 --slug');
  }
  throw new Error(`存在多个任务，请指定 --slug：${candidates.join('、')}`);
}
