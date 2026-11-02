---
name: devflow-engineering-flow
description: Use when the user asks to build, change, or fix something in a project initialized with devflow, or asks which stage to run next. Explains the six-stage flow and its gates.
---

# devflow 六阶段流程

## 何时使用

- 项目里存在 `.claude/hub/hub.yaml`。
- 用户提出功能、改造、缺陷，或问“下一步做什么”。
- 需要判断该跳过还是补齐某个阶段。

不确定当前进度时，先运行 `/devflow:status`：它只读扫描 `docs/devflow/` 的产物，给出各任务的阶段与下一步命令。

## 流程

```
完整：  req → plan → implement → test → review
轻量功能：req --light → implement → test → review        （brief.md）
轻量修复：debug → test [→ review]                        （debug.md）
                         └── debug ←┘（完整流程中 test/implement 失败时）
```

- **req**：目标、验收标准、边界、影响面。产出 `docs/devflow/<slug>/req.md`。
- **req --light**：小功能，合并 req 与 plan，产出 `brief.md`；实现后仍需 test 与 review。
- **plan**：现状、方案、任务拆分、测试策略、回滚。产出 `plan.md`。
- **implement**：按计划（或 `brief.md`）小步实现，测试先行。
- **test**：真实运行测试，记录结果。
- **review**：缺陷导向审查 diff，并逐条对照验收标准收敛。
- **debug**：test 或 implement 失败时进入；修复并补回归测试后回到 test。独立小 bug 直接由 debug 产出 `debug.md`，不要求 req/plan；普通小 bug 测试通过即结束，标记 `review: required` 的才补 review。

## 怎么选阶段

| 用户意图 | 阶段 |
| --- | --- |
| 只有模糊诉求 | req |
| 小功能、改动范围明确 | req --light（`brief.md`） |
| 需求清楚但方案未定 | plan |
| 方案已定要改代码 | implement |
| 改完要验证 | test |
| 准备提交或交付 | review |
| 报错、测试失败、行为异常 | debug |

小改动可以减少文档，但**不能跳门禁**：没有验收标准不实现，没有测试结果不审查。

## 轻量流程的升级条件

轻量只压缩文档，不减测试：小功能始终 review；小 bug 普通修复测试通过即结束，安全、数据、认证/权限/并发风险用 `review: required` 补审。命中以下任一硬触发时，停止轻量、在 `brief.md` / `debug.md` 写 `## 升级判断`，补 `req.md` / `plan.md` 后继续完整流程：

- 新增/升级依赖，公共 API、数据结构或迁移，权限/认证/支付/并发/安全边界，不可逆操作。
- 非测试/文档 diff 超过 200 行、10 个文件或 2 个子项目。
- 小 bug 根因跨 >2 文件/模块、连续 2 轮假设未收敛、修复要改公共契约。

小 bug 的安全、数据、认证/权限/并发风险若不触发上述升级，用 `debug.md` 顶部的 `review: required` 补审，而不是只靠对话记录；小功能命中这些风险时必须升级完整流程，不能只补 review。无法稳定复现不是升级条件：停在 debug 记录证据与盲区。

80–200 行或 5–10 个文件属于软提示：先询问一次，记录后继续。计数口径：`git diff --numstat`（staged + unstaged），排除 `docs/devflow/**`、测试文件、lockfile 与生成物。

## 产物与状态

- 完整任务：`req.md`、`plan.md`、`test.md`、`review.md`。
- 轻量功能：`brief.md`、`test.md`、`review.md`。
- 轻量修复：`debug.md`、`test.md`，`review.md` 视 `debug.md` 顶部的 `review: required` 而定。
- 阶段由产物推断，不存状态机；`/devflow:status` 会显示任务是完整、轻量功能还是轻量修复。

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

## 工具路由

项目可能在 `.claude/hub/ecosystem.yaml` 声明同类工具（superpowers、BMAD、Spec Kit、OpenSpec 等）。阶段入口会先运行 `devflow route --stage <stage>` 判断是否应委派；路由只决定“谁执行技法”，不改变阶段顺序、门禁与 `docs/devflow/<slug>/` 产物。

- `routing.mode: ask`（默认）：命中时说明候选并询问；用户未同意就继续 devflow。
- `routing.mode: auto`：只自动委派 `kind: technique` 的工具（只接管执行技法）；`workflow` 类工具仍只建议，避免整个流程被静默替换。
- `routing.mode: off`：不路由。
- `--force-devflow` / `--no-route` / `--tool devflow`：强制使用 devflow。
- `--tool <id>`：显式指定工具；未安装时仍按指定执行，但会提示风险。
- 路由返回 `error` 时停止并报告原因，不继续本阶段。

检测结果写在 `.claude/.ecosystem-state.json`（已 gitignore），由 `devflow route --detect` 或 `/devflow:init` 刷新；进入阶段时若结果缺失或过期，`devflow route` 会自动检测一次。它只检查技能目录与项目/用户 `settings.json`、`settings.local.json` 的 `enabledPlugins` 是否存在，不读取技能内容、不执行外部工具。检测是启发式的，安装或禁用工具后需重新检测。

## 反模式

- 没需求就写代码；没计划就大改。
- 测试没跑就说通过。
- 审查只夸不挑。
- 排障靠猜，不复现。
- 同时维护 superpowers 计划与 `plan.md` 两份方案。
