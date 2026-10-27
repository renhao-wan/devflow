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
req → plan → implement → test → review → debug
```

- **req**：目标、验收标准、边界、影响面。产出 `docs/devflow/<slug>/req.md`。
- **plan**：现状、方案、任务拆分、测试策略、回滚。产出 `plan.md`。
- **implement**：按计划小步实现，测试先行。
- **test**：真实运行测试，记录结果。
- **review**：缺陷导向审查 diff。
- **debug**：测试失败或行为异常时进入；修复后补回归测试。

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

## 反模式

- 没需求就写代码；没计划就大改。
- 测试没跑就说通过。
- 审查只夸不挑。
- 排障靠猜，不复现。
