---
name: review
description: 审查阶段：以缺陷为导向检查 diff，输出阻断项与建议项
argument-hint: [范围或 slug] [--force-devflow]
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, Skill, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(node:*), Bash(devflow:*)
---

执行 devflow 审查阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/review/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/review/SKILL.md`；方法可用 `devflow-code-review` 技能，已安装 superpowers 时也可用其 `requesting-code-review` / `receiving-code-review` 技能，门禁与产物仍以本阶段为准。
   - 工具路由（可跳过）：运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-route.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --stage review <用户参数>`；未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-route.mjs --stage review <用户参数>`。用户参数中的 `--force-devflow` 原样透传。
   - `use-devflow`：直接继续本阶段。
   - `suggest`：说明候选工具与理由并询问；用户未同意时继续 devflow。
   - `delegate`：在技能上下文中用 `Skill` 工具调用 `invoke`（去掉前导 `/`，如 `superpowers:requesting-code-review`）；无法调用时说明原因并询问是否继续 devflow。阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由本阶段负责。
   - `error`：停止并报告命令输出中的原因，不要继续本阶段。
2. 未提供 slug 时，扫描 `docs/devflow/*/plan.md`：只有一个候选就采用；多个时列出候选让用户选择，不要自行挑选，也不要用 `latest` 代替。
3. 查看全量 diff（`git status`、`git diff`、必要时 `git diff --staged`），确认改动范围。
4. 读取 `docs/devflow/<slug>/req.md` 与 `plan.md`，逐条对照验收标准与任务清单：每条验收标准是否有实现或测试支撑，未覆盖项是否已明确接受。结果写入 review 的「验收对照」表。
5. 核对 `plan.md` 的「调研与复用判断」：来源是否可核对、许可证与 `req.md` 技术约束是否冲突、依赖维护状态与已知漏洞、搜索失败或未验证项是否已披露。结果写入「复用与依赖检查」表。
6. 按 SKILL 的顺序检查：正确性 → 安全 → 兼容 → 可维护 → 测试缺口 → 复用与依赖。
7. 需要独立视角时，调用 `devflow-code-reviewer` 子代理审查，再合并判断；子代理结论也要自己核实。
8. 每条问题给出 `文件:行号`、触发条件、建议；区分阻断项与建议项。
9. 结论写入 `docs/devflow/<slug>/review.md`。
10. 报告时先列阻断项；没有阻断项也要说明检查过哪些维度、验收标准的收敛结果与复用判断的核对结果。
11. 无阻断项后提交或交付；若改过 `.claude/hub/stages/`，运行 `/devflow:upstream --stage <stage>` 回灌插件模板。
