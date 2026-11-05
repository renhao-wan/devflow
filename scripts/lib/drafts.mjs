import { DRAFT_MARKER } from './common.mjs';
import { isValidStackName, stackNameForLabel } from './stacks.mjs';

/**
 * 项目级基础规则草稿。
 * 首行标记让 gen/sync/upstream 跳过；填写完删除标记后才会被当作规则。
 */
export function renderProjectBasicsDraft() {
  return `${DRAFT_MARKER}
# 项目基础规则（草稿）

> 本文件由 init 生成，是占位草稿而不是规则：\`TODO\` 行需要替换为项目真实约定，整段不需要就删除。
> 所有阶段都会读取本文件，请保持精简。
> 放置原则：所有阶段适用放 \`_shared/\`；只影响某阶段放 stages/<stage>/SKILL.md；只影响某技术栈放 stacks/<stack>/；只影响某子项目放 overrides/<sub>/<stage>.md。
> 不确定时使用 devflow-rule-placement 技能。

## 项目背景

- TODO: 一句话说明项目做什么、主要用户是谁。

## 技术约束

- TODO: 运行时、框架、数据库版本；没有特殊约束就删除本节。

## 安全与数据

- 不提交密钥、token 或真实用户数据。
- TODO: 本项目的敏感数据、权限边界与不可逆操作。

## 协作约定

- TODO: 分支、提交信息与评审方式；没有约定就删除本节。
`;
}

/** 单一技术栈被自动声明时生成的栈草稿。 */
export function renderStackDraft({ label, name }) {
  const title = label && label !== name ? `${label} 通用规范` : `${name} 通用规范`;
  return `${DRAFT_MARKER}
# ${title}（草稿）

> 本文件由 init 生成，是占位草稿：\`TODO\` 行需要替换为项目真实约定，不适用的整段删除。
> 本文件对该技术栈的所有阶段生效；只影响某个阶段的规则放 <stage>.md。
> 填写完成后删除首行的草稿标记。

## 版本与依赖

- TODO: 主要运行时/框架版本与依赖约束。

## 代码结构

- TODO: 分层、模块边界与命名约定。

## 测试

- TODO: 测试框架、最低要求与常用命令。
`;
}

/**
 * 返回需要写入的草稿清单。只做渲染，不读写文件。
 * @param {{ detected?: { names: string[], labels: string[] }, stackName?: string|null }} options
 */
export function planDrafts({ detected = { names: [], labels: [] }, stackName = null } = {}) {
  const drafts = [{
    rel: '.claude/hub/_shared/project-basics.md',
    content: renderProjectBasicsDraft(),
  }];
  if (stackName && isValidStackName(stackName) && detected.names.includes(stackName)) {
    const label = detected.labels.find((item) => stackNameForLabel(item) === stackName) || stackName;
    drafts.push({
      rel: `.claude/hub/stacks/${stackName}/_shared.md`,
      content: renderStackDraft({ label, name: stackName }),
    });
  }
  return drafts;
}
