---
name: debug
description: 排障阶段：先复现再定位，验证根因后修复并补回归测试
argument-hint: <问题描述或报错信息> [--force-devflow]
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, Agent, AskUserQuestion, Skill, Bash(*)
---

执行 devflow 排障阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/debug/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/debug/SKILL.md`；方法可用 `devflow-systematic-debugging` 技能，需要并行验证假设时用 `devflow:devflow-debug-investigator` 子代理（旧版本可能显示为 `devflow-debug-investigator`，以 `/agents` 列表为准）。
   - 工具路由（可跳过）：运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-route.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --stage debug <用户参数>`；未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-route.mjs --stage debug <用户参数>`。用户参数中的 `--force-devflow` 原样透传。
   - `use-devflow`：直接继续本阶段。
   - `suggest`：说明候选工具与理由并询问；用户未同意时继续 devflow。
   - `delegate`：在技能上下文中用 `Skill` 工具调用 `invoke`（去掉前导 `/`，如 `superpowers:systematic-debugging`）；无法调用时说明原因并询问是否继续 devflow。只借用调查技法；轻量修复不采用路由给出的 workflow 类工具，需要完整工作流时先升级完整流程。阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由本阶段负责，`debug.md` 是唯一产物，不并存第二份报告。
   - `error`：停止并报告命令输出中的原因，不要继续本阶段。
2. 若问题属于已有任务，读取 `docs/devflow/<slug>/` 下的 req/plan/test；slug 不唯一时先用 `AskUserQuestion` 确认，不要猜。无法提问时列出候选并等待用户回复。
   - 独立小 bug（正确行为已由现有代码、测试或需求定义）直接在本阶段修复，写 `docs/devflow/<slug>/debug.md`，不要求 `req.md`/`plan.md`，之后进入 `/devflow:test <slug>`。slug 从问题描述提炼（小写字母、数字、连字符），已有任务复用其 slug；无法确定时先询问。轻量修复不切换 workflow 类工具；需要完整工作流时先升级完整流程。
   - 涉及安全、数据、认证/权限/并发等高风险、但不触发升级的修复，在 `debug.md` 顶部前 10 行写 `review: required`，测试通过后再补 `/devflow:review <slug>`；不确定是否涉及风险时按需要 review 处理。测试后 review 阶段仍会运行 triage，按实际 diff 复核风险，标记是显式要求而不是唯一依据。
   - 硬触发（根因跨 >2 文件或 >2 模块、连续 2 轮假设未收敛、改公共接口/公共契约、涉及数据结构/迁移/依赖/不可逆、非测试/文档 diff >200 行或 >10 文件或 >2 子项目）先写 `## 升级判断` 并升级完整流程；公共接口/迁移/依赖不在轻量路径继续。80–200 行或 5–10 文件时先用 `AskUserQuestion` 询问一次，记录后继续；无法提问时回退为文本询问。
3. 先复现：拿到最小、稳定、可重复的命令或步骤。不能复现时说明缺什么，不要盲改；停在 debug 记录证据与盲区，不因此升级完整流程（完整流程同样依赖复现）。
4. 收集证据：完整错误、日志、相关输入、最近改动。
5. 需要时检索已知问题：用完整错误、错误码、依赖版本查官方 issue、变更日志与社区讨论；外部结论只作线索，必须本地复现验证。搜索失败时记录未验证项与盲区，不得把“没搜到”写成“没有已知问题”。
6. 缩小范围并提出假设，一次只改变一个变量；实验必须可丢弃。若有 ≥2 个互不依赖的假设，可在同一条消息并行启动多个 `devflow:devflow-debug-investigator`，每个只验证一个假设并返回证据；合并时区分一致、冲突与未验证，最终以本地复现为准。需要撤销实验改动时用 `/rewind`（会丢弃当前会话改动，先确认范围）；需要隔离并行实验时用 `/worktree`。
7. 找到根因后再修复，不吞异常、不加无意义重试。
8. 补一个修复前失败、修复后通过的回归测试。
9. 清理临时日志与调试代码。
10. 报告：实际 slug、`docs/devflow/<实际 slug>/debug.md` 路径、现象、根因、修复、验证方式；给出结论（`fixed` / `partial` / `unresolved`）；`partial` 或 `unresolved` 时必须写明未排除的风险与下一步；如做了外部检索，写明来源与本地验证结果。
11. 可选：排障跨多回合时，提示用户运行 `/goal` 设置本阶段完成条件（稳定复现或失败测试、根因有证据、回归测试修复前失败修复后通过、结论明确；模板见 `.claude/hub/stages/debug/SKILL.md`）。插件不会自动设置 goal；goal 不替代门禁；无法复现或需人工判断风险时不要建议启用。
12. 修复并补回归测试后回到测试阶段：`/devflow:test <实际 slug>`；普通小 bug 由测试阶段的 triage 判定是否审查（`review: required`、用户指定方向/数量或风险信号会进入 `/devflow:review`；否则记录基线检查后结束）。
