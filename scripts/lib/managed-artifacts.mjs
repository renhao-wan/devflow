/**
 * 项目侧受管产物的单一真源：init 生成的 .gitignore 块与 clean 的删除清单共用。
 * 只描述"devflow 在项目里放了什么"，删除策略由 hub-clean 决定。
 */
import { LOADERS } from './loaders.mjs';

export const HUB_DIR = '.claude/hub';
export const DOCS_DIR = 'docs/devflow';

/** 默认档：可再生的生成物与元数据。 */
export const DEFAULT_ARTIFACTS = [
  ...Object.keys(LOADERS).map((file) => `scripts/${file}`),
  '.claude/skills/devflow-*',
  '.claude/.hub-manifest.json',
  '.claude/.hub-sources.json',
  '.claude/.hub-bases',
  '.claude/.stack-sources.json',
  '.claude/.stack-bases',
  '.claude/.stack-staging',
  '.claude/.devflow-state.json',
  '.claude/.ecosystem-state.json',
  '.devflow.json',
];

/** 需要显式开关才删除的项目资产。 */
export const OPTIONAL_ARTIFACTS = {
  hub: [HUB_DIR],
  docs: [DOCS_DIR],
};

/** 始终保留：备份与审计记录。 */
export const PRESERVED_ARTIFACTS = [
  '.claude/.stack-trash',
  '.claude/.devflow-trash',
  'docs/upstream-log.md',
];

/** .gitignore 块的受管路径；trash 只忽略、不清理。 */
export const GITIGNORE_PATHS = [
  ...Object.keys(LOADERS).map((file) => `scripts/${file}`),
  '.claude/skills/devflow-*/',
  '.claude/.hub-manifest.json',
  '.claude/.hub-sources.json',
  '.claude/.hub-bases/',
  '.claude/.stack-sources.json',
  '.claude/.stack-bases/',
  '.claude/.stack-staging/',
  '.claude/.stack-trash/',
  '.claude/.devflow-trash/',
  '.claude/.devflow-state.json',
  '.claude/.ecosystem-state.json',
  '.devflow.json',
  'docs/devflow/*/.archive/',
];

export function gitignoreBlock() {
  return `# >>> devflow (generated, do not commit)\n${GITIGNORE_PATHS.join('\n')}\n# <<< devflow\n`;
}
