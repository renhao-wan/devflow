---
name: devflow-rule-placement
description: Use when a project rule, convention, or constraint needs to be written into a devflow workspace and it is unclear whether it belongs in _shared, stages, stacks, or overrides.
---

# 规则落位

## 何时使用

- 用户说“以后都……”“这个项目约定……”“别用……”“我们团队要求……”。
- 规则只存在于对话、issue 或任务文档中，还没有进入 `.claude/hub/`。
- 已有规则需要修改，但不确定应改哪个文件。
- 多个目录都有相似内容，需要判断哪一处才是真源。

不要把所有规则都塞进 `_shared/`：范围越窄的规则，越应该放到阶段、技术栈或子项目层。

## 落位决策

| 规则影响范围 | 落位 |
| --- | --- |
| 所有阶段、所有子项目 | `.claude/hub/_shared/<topic>.md` |
| 只影响某个阶段 | `.claude/hub/stages/<stage>/SKILL.md`；细则放该阶段 `references/` |
| 只影响某语言/框架 | `.claude/hub/stacks/<stack>/_shared.md` 或 `<stage>.md` |
| 只影响某个子项目 | `.claude/hub/overrides/<sub>/<stage>.md` |
| 只影响当前任务 | 留在 `docs/devflow/<slug>/`，不落位 |

规则同时命中多个范围时，先判断“最小充分范围”：只对某个子项目成立，就不要写进 `_shared/`；只对某个阶段成立，就不要写进 `_shared/`。

## 流程

1. 用一句话复述规则，确认适用范围。无法判断时用 `AskUserQuestion` 给出“全局 / 某阶段 / 某技术栈 / 某子项目 / 仅当前任务”五类选项。
2. 用 `Grep` 搜索 `.claude/hub/` 中是否已有同主题规则。已有就改那一处，不新增重复文件。
3. 读取目标文件；不存在时按最小骨架创建。目标必须位于 `.claude/hub/` 内，父目录不能被 junction/符号链接引到项目外。
4. 写入可执行规则：**条件 + 动作 + 例外**。例如“新增 HTTP 接口必须同时补集成测试，除非该接口只做静态转发。”
5. 判断是否需要重新生成：
   - 新增/删除规则文件、修改 `hub.yaml`（阶段、子项目、`stack` 映射）→ 运行 `node scripts/devflow-gen.mjs`。
   - 只修改已有 `_shared/`、`stages/`、`stacks/`、`overrides/` 文件的正文 → 不需要 gen，投影只记录路径，正文会被执行时直接读取。
6. 如果目标文件首行是 `<!-- devflow:draft -->`，说明它还是草稿：提醒用户填写完删除该标记；规则草稿不会被投影、同步或回灌。阶段入口 `stages/<stage>/SKILL.md` 不能标记为草稿。
7. 运行 `node scripts/devflow-doctor.mjs`，确认无越界、无缺失、无过期投影。

## 写法

- 一条规则只写一个可判定条件，不要把多条无关约束塞进一段。
- 写项目真实的约定，不写“注意代码质量”“保持良好风格”这类无法执行的口号。
- 有例外就写出来；没有例外不要补“视情况而定”。
- 引用外部文档时写路径或链接，不整段复制。
- 安全与门禁规则只能收紧，不能放宽。

## 去重与冲突

- 同一规则只保留一处真源；发现重复时合并到范围最小的位置，并删除其他副本。
- 读取优先级：阶段门禁与安全底线 > `overrides` > `stacks/<stack>/<stage>.md` > `stacks/<stack>/_shared.md` > `_shared` > 阶段默认做法。
- `overrides` 与 `stacks` 冲突时以 `overrides` 为准；任何一层都不得放宽阶段门禁与安全底线。

## 边界

- 不直接修改 `.claude/skills/devflow-*`；那是生成投影，改源文件后重新生成。
- 不把规则写到用户 home、插件缓存或项目外目录。
- 不把项目专属内容（绝对路径、内网地址、子项目名、密钥）回灌到个人库/团队库。
- 不创建空的 `overrides/` 目录；没有真实子项目差异就不建。
- 不确定是否可复用时，先留在任务文档，确认后再落位。

## 输出

告知用户：落位文件、为什么选这一层、是否需要运行 gen、是否还有草稿标记未删除。
