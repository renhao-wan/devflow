import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 显式声明的阶段优先；未声明或为空时回退扫描 `.claude/hub/stages/`。生成器与 doctor 共用，避免两处视图不一致。 */
export function stageList(config = {}, root) {
  const declared = config?.stages;
  if (Array.isArray(declared) && declared.length) return declared.map(String);
  const dir = join(root, '.claude', 'hub', 'stages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
