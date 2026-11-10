---
name: test
description: 测试阶段：运行项目测试并记录结果，覆盖正常、边界与错误路径，明确未覆盖部分。
---

# 测试阶段（test）

## 何时使用

- 实现完成，需要验证。
- 修复缺陷后需要回归（轻量修复的输入是 `debug.md`）。
- 需要在交付前拿到可信的验证证据。

## 执行步骤

1. **确定命令**：优先使用 `hub.yaml` 中该子项目的 `testCommand`；没有则用 `defaults.testCommand`。
2. **先跑全量**：确认基线；记录通过/失败数量。可用 `devflow:devflow-test-runner` 子代理执行并汇总（旧版本可能显示为 `devflow-test-runner`，以 `/agents` 列表为准），但报告需自己核对。
3. **跑针对性用例**：覆盖本次改动的正常路径、边界、错误路径。可先运行 `node scripts/devflow-test.mjs --changed`（或 `devflow test --changed`）列出可能受影响的已存在测试；它只按文件命名与目录约定提示，不执行测试、不阻断，无法映射的源码文件会标为 `[UNMAPPED]`，这类改动优先跑全量。
4. **手动验证不能替代测试**：涉及 UI/接口时补充手动步骤，但要在报告中单列。
5. **检查测试缺口**：运行 `node scripts/devflow-test.mjs --gaps`（插件根可用时也可用 `devflow test --gaps`）。它按实际 diff 列出没有同名测试文件或测试改动的源码文件，只提示、不阻断；逐条确认是“已有测试覆盖（写明测试文件与依据）”“新增测试”还是“明确不测（写明原因）”。
6. **记录验收覆盖**：在 `## 验收覆盖` 表中按验收 ID（`req.md` / `brief.md` / `debug.md` 中的 `AC-1`、`AC-2`…）逐条填写测试或证据与结论；没有证据的项写“未覆盖（原因）”，不得写成通过。
7. **记录结果**：记录一次真实运行：`node scripts/devflow-test.mjs --command "<命令>" --exit-code <退出码> --duration-ms <耗时>`。退出码 0 写入通过并清除待测试标记；非 0 记为失败、保留待测试标记，不更新通过时间。缺省 `--exit-code 0` 兼容旧用法。
8. **失败处理**：测试失败先进入 debug 阶段，不修改断言迁就实现；失败记录也要如实写入（带非 0 退出码），不要用通过记录覆盖。
9. **判断后续**：同一 slug 存在多套产物时按完整流程优先（`plan.md` > `brief.md` > `debug.md`）。轻量修复运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/review-triage.mjs" --root . --slug <slug> --write`（未设置插件根时用 `node scripts/devflow-triage.mjs`）：`trigger` 为 `skipped` 时测试通过即完成，并记录基线检查结论；其他触发（`review: required`、用户指定方向/数量、安全/数据/并发等风险信号，或无法统计改动时的 `auto`）进入 `/devflow:review`。轻量功能与完整任务始终进入 review。

## 可选完成条件（/goal）

本阶段可选使用原生 `/goal` 维持跨回合推进；插件不会自动设置，goal 也不替代门禁。建议条件：

- 全量测试与针对性用例已执行；
- `test.md` 记录真实命令、环境与通过/失败数量；
- 失败项已处理，或明确标记为未覆盖/手动验证。

测试命令或环境尚未确定时，不要启用 goal。

## 门禁（全部满足才能进入 review；轻量修复可能在此结束）

- [ ] 全量测试命令已执行，结果已记录。
- [ ] 已运行 `--changed` 或说明为何直接跑全量；`[UNMAPPED]` 的改动已覆盖或说明原因。
- [ ] 测试结果已用 `devflow-test.mjs` 记录，含真实退出码；失败结果没有被写成通过。
- [ ] 新增逻辑至少有一条测试直接覆盖。
- [ ] 已运行 `--gaps` 测试缺口提示，或在 `test.md` 说明无法运行的原因；提示的每个源码文件都有对应测试或明确的不测理由。
- [ ] `## 验收覆盖` 已按验收 ID 逐条填写证据与结论；没有证据的项未写成通过。
- [ ] 边界与错误路径各有验证，或有明确未覆盖说明。
- [ ] 没有“暂时跳过”的测试未说明原因。
- [ ] 手动验证项（如有）已列出，且没有伪装成自动化结果。
- [ ] 轻量修复的回归测试与 `debug.md` 记录一致（命令、修复前失败、修复后通过）。
- [ ] 轻量修复已运行 triage 并记录 `trigger`；`skipped` 时写明基线检查结论，其他触发进入 review。轻量功能与完整任务不依赖 triage，也不得因普通小 bug 的默认行为被无必要地推进 review。
- [ ] 已运行 `devflow check --stage test --slug <slug>`（未设置 CLI 时用 `node scripts/devflow-check.mjs --stage test`），退出码 0；它校验测试命令、结果表、验收覆盖与 AC 引用。

## 产出

- 测试结果报告（写入对话与 `docs/devflow/<slug>/test.md`），骨架见 `templates/test-report.template.md`。每次重跑整份覆盖该文件，不追加历史运行记录；旧记录用 `devflow change --slug <slug> --from test` 归档。
- 记录要求见 `references/evidence.md`：没有实际执行的结果不得写成通过。
- `.claude/.devflow-state.json` 中的最近一次测试记录（状态、退出码、耗时与命令）。
- 轻量修复未标记 `review: required` 时，`test.md` 就是该任务的最终产物。

## 技术栈规范

如果 `.claude/skills/devflow-<stage>/SKILL.md` 中存在「技术栈规范」映射，处理某个子项目时读取其对应文件；只读任务涉及的子项目，不预读全部。
技术栈规范与 `overrides` 冲突时以 `overrides` 为准，且不得放宽阶段门禁与安全底线。

## 边界

- 不删除、跳过失败的测试来“通过”。
- 不把未运行的测试写成通过。
- `--gaps` 与 `--changed` 都是启发式提示：只看文件名与常见测试目录，不解析测试内容，绝不据此判定“未覆盖”或阻断交付。
- `.claude/.devflow-state.json` 只记录调用方显式传入的结果，不解析测试框架 stdout；退出码判断与失败原因以实际命令输出为准。
- 环境缺失导致无法运行时，明确报告缺失项，而不是猜测结果。
- 不把普通小 bug 默认推进 review；轻量修复是否需要 review 由 test 阶段的 triage 按实际 diff 判定，`debug.md` 顶部的 `review: required` 是显式要求并优先于跳过结论。
- 发现可复用的项目规则时，用 `devflow-rule-placement` 判断落位；不直接改 `.claude/skills/devflow-*` 投影。
- 测试记录更新后 review 必须重跑；需要归档旧测试与审查时用 `devflow change --slug <slug> --from test --apply`，随后按输出运行 `/devflow:test`。
