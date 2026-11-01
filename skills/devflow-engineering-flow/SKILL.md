---
name: devflow-engineering-flow
description: Use when the user asks to build, change, or fix something in a project initialized with devflow, or asks which stage to run next. Explains the six-stage flow and its gates.
---

# devflow 六阶段流程

## 何时使用

- 项目里存在 `.claude/hub/hub.yaml`。
- 用户提出功能、改造、缺陷，或问“下一步做什么”。
- 需要判断该跳过还是补齐某个阶段。

## 流程

```
req → plan → implement → test → review
                 ↑          │
                 └── debug ←┘
```

- **req**：目标、验收标准、边界、影响面。产出 `docs/devflow/<slug>/req.md`。
- **plan**：现状、方案、任务拆分、测试策略、回滚。产出 `plan.md`。
- **implement**：按计划小步实现，测试先行。
- **test**：真实运行测试，记录结果。
- **review**：缺陷导向审查 diff，并逐条对照验收标准收敛。
- **debug**：test 或 implement 失败时进入；修复并补回归测试后回到 test，不是 review 之后的必经阶段。

## 怎么选阶段

| 用户意图 | 阶段 |
| --- | --- |
| 只有模糊诉求 | req |
| 需求清楚但方案未定 | plan |
| 方案已定要改代码 | implement |
| 改完要验证 | test |
| 准备提交或交付 | review |
| 报错、测试失败、行为异常 | debug |

小改动可以合并阶段（如 req+plan），但**不能跳门禁**：没有验收标准不实现，没有测试结果不审查。

## 门禁原则

每个阶段的门禁写在 `.claude/hub/stages/<stage>/SKILL.md`。执行前必须完整读取该文件；项目可能已改成自己的规则。

门禁不满足时，明确说出缺口并停在该阶段，不要口头保证后继续。

## 单一真源

- 项目规则：`.claude/hub/stages/<stage>/SKILL.md`
- 阶段细则与产出骨架：同目录下的 `references/`、`templates/`，按需读取
- 生成的投影：`.claude/skills/devflow-<stage>/SKILL.md`（勿手改）
- 改动源后运行 `node scripts/devflow-gen.mjs`

## 与 superpowers 的协作边界

devflow 与 superpowers 都覆盖“计划、TDD、排障、评审”，但职责不同，不要同时维护两份：

| 维度 | devflow | superpowers |
| --- | --- | --- |
| 管什么 | 阶段顺序、产物路径、门禁、项目真源、回灌与同步 | 执行技法：brainstorming、writing-plans、TDD、systematic-debugging、requesting-code-review / receiving-code-review、verification、worktrees |
| 产物放哪 | `docs/devflow/<slug>/` 下的 `req.md`、`plan.md` 等 | 由对应技能自行约定 |
| 权威性 | 项目规则以 `.claude/hub/stages/<stage>/SKILL.md` 为准 | 作为方法来源 |

协作规则：

- 阶段顺序、产物路径与门禁冲突时，**以 devflow 为准**。
- 已有 superpowers 的 `brainstorming` 结果或 `writing-plans` 计划时，把结论吸收进 `plan.md`，不并存两份设计/计划。
- 需要发散方案、拆解执行步骤、系统排障时，优先用 superpowers 的技能；需要确认“现在该走哪个阶段、产物落在哪、门禁过没”时，用 devflow。
- 未安装 superpowers 时，devflow 自带的 TDD、系统排障、代码评审技能作为 fallback。

## 反模式

- 没需求就写代码；没计划就大改。
- 测试没跑就说通过。
- 审查只夸不挑。
- 排障靠猜，不复现。
- 同时维护 superpowers 计划与 `plan.md` 两份方案。
