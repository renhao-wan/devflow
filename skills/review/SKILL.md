---
name: review
description: 审查阶段：以缺陷为导向检查 diff，输出阻断项与建议项
argument-hint: [slug] [--focus <方向>]... [--agents 0-4] [--no-subagents] [--focus-only] [--base <ref>] [--force-devflow]
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, Agent, AskUserQuestion, Skill, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(node:*), Bash(devflow:*)
---

执行 devflow 审查阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/review/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/review/SKILL.md`；方法可用 `devflow-code-review` 技能，已安装 superpowers 时也可用其 `requesting-code-review` / `receiving-code-review` 技能，门禁与产物仍以本阶段为准。
   - 工具路由（可跳过）：运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-route.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --stage review <用户参数>`；未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-route.mjs --stage review <用户参数>`。用户参数中的 `--force-devflow` 原样透传。
   - `use-devflow`：直接继续本阶段。
   - `suggest`：说明候选工具与理由并询问；用户未同意时继续 devflow。
   - `delegate`：在技能上下文中用 `Skill` 工具调用 `invoke`（去掉前导 `/`，如 `superpowers:requesting-code-review`）；无法调用时说明原因并询问是否继续 devflow。阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由本阶段负责。
   - `error`：停止并报告命令输出中的原因，不要继续本阶段。
2. 未提供 slug 时，扫描 `docs/devflow/*/plan.md`、`docs/devflow/*/brief.md` 与 `docs/devflow/*/debug.md`，按 slug 去重：只有一个候选就采用；多个时用 `AskUserQuestion` 让用户选择，不要自行挑选，也不要用 `latest` 代替；无法提问时列出候选并等待回复。没有候选时提示先运行 `/devflow:status` 或确认 slug。
3. 运行审查 triage，得到是否必审、风险等级、选中方向与子代理上限：
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/review-triage.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --slug <slug> --write`（未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-triage.mjs`）。
   - 用户指定方向：`--focus security`（可重复或逗号分隔）；指定后只审这些方向，其余方向会让位并留痕。
   - 用户指定数量：`--agents 0-4`；`--no-subagents` 只审不派代理；`--focus-only` 只做基线检查。
   - 分支对比：`--base <ref>`；默认只对比工作区与暂存改动。
   - 结果写入 `docs/devflow/<slug>/review-triage.json`；`trigger=skipped` 时仍要做基线检查并写明跳过依据。
4. 查看全量 diff（`git status`、`git diff`、必要时 `git diff --staged`），确认改动范围。
5. 按验收来源逐条对照：完整任务读 `req.md` 与 `plan.md`；轻量功能读 `brief.md`；轻量修复读 `debug.md` 的「正确行为依据」。每条验收标准是否有实现或测试支撑，未覆盖项是否已明确接受。结果写入 review 的「验收对照」表。
6. 核对复用与依赖：完整任务读 `plan.md` 的「调研与复用判断」；确认来源可核对、许可证与技术约束不冲突、依赖维护状态与已知漏洞、搜索失败或未验证项已披露。轻量任务未涉及依赖与调研时写“不适用”，涉及新增依赖则必须已升级完整流程。结果写入「复用与依赖检查」表。
7. 核对轻量任务的「升级判断」：轻量功能按 req 的硬触发（依赖、公共接口/契约、数据结构/迁移、权限/认证/支付/并发/安全边界、不可逆、>200 行、>10 文件、>2 子项目）；轻量修复按 debug 的硬触发（根因跨 >2 文件或 >2 模块、连续 2 轮假设未收敛、公共契约、数据结构/迁移、依赖、不可逆、规模阈值），并核对安全/数据/认证/并发风险是否已标记 `review: required`。命中却未记录、或该升级却只补 review 时，列为阻断项。
8. 按 triage 的 `selected` 顺序检查：正确性 → 安全 → 兼容 → 可维护 → 测试缺口 → 复用与依赖；`excluded` 中的方向不派代理，但要确认理由成立。
9. 按画像派子代理：数量不超过 `maxAgents`，分组为 A 正确性+并发、B 安全+依赖、C 验收与回归+测试质量、D 数据与迁移、E 可维护性。调用 `devflow:devflow-code-reviewer` 子代理（旧版本可能显示为 `devflow-code-reviewer`，以 `/agents` 列表为准），再合并判断；子代理结论也要自己核实。`maxAgents=0` 时自己按选中方向审一遍。
   - 内置命令可选：当前版本提供 `/code-review` 时可作第二视角，结论需自己核实；`/security-review`、`/ultrareview` 可能外发代码，必须先获用户明确同意，未同意不执行；`/simplify` 若应用修改，回到 implement 并重新 test。命令不可用时跳过并记录“未使用”。
10. 每条问题给出 `文件:行号`、触发条件、建议；区分阻断项与建议项。
11. 结论写入 `docs/devflow/<slug>/review.md`；轻量任务可写短（范围、触发与画像、验收对照、阻断项、结论）。
12. 报告时先给出实际 slug 与 `docs/devflow/<实际 slug>/review.md` 路径，再列触发结果、风险等级、选中/排除方向与阻断项；没有阻断项也要说明检查过哪些维度、验收标准的收敛结果与复用判断的核对结果。
13. 无阻断项后提交或交付；若改过 `.claude/hub/stages/`，运行 `/devflow:upstream --stage <stage>` 回灌插件模板。
