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
3. **跑针对性用例**：覆盖本次改动的正常路径、边界、错误路径。
4. **手动验证不能替代测试**：涉及 UI/接口时补充手动步骤，但要在报告中单列。
5. **检查测试缺口**：运行 `node scripts/devflow-test.mjs --gaps`（插件根可用时也可用 `devflow test --gaps`）。它按实际 diff 列出没有同名测试文件或测试改动的源码文件，只提示、不阻断；逐条确认是“已有测试覆盖（写明测试文件与依据）”“新增测试”还是“明确不测（写明原因）”。
6. **记录结果**：测试通过后运行 `node scripts/devflow-test.mjs --command "<命令>"`，写入状态。
7. **失败处理**：测试失败先进入 debug 阶段，不修改断言迁就实现。
8. **判断后续**：同一 slug 存在多套产物时按完整流程优先（`plan.md` > `brief.md` > `debug.md`）。轻量修复运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/review-triage.mjs" --root . --slug <slug> --write`（未设置插件根时用 `node scripts/devflow-triage.mjs`）：`trigger` 为 `skipped` 时测试通过即完成，并记录基线检查结论；其他触发（`review: required`、用户指定方向/数量、安全/数据/并发等风险信号，或无法统计改动时的 `auto`）进入 `/devflow:review`。轻量功能与完整任务始终进入 review。

## 可选完成条件（/goal）

本阶段可选使用原生 `/goal` 维持跨回合推进；插件不会自动设置，goal 也不替代门禁。建议条件：

- 全量测试与针对性用例已执行；
- `test.md` 记录真实命令、环境与通过/失败数量；
- 失败项已处理，或明确标记为未覆盖/手动验证。

测试命令或环境尚未确定时，不要启用 goal。

## 门禁（全部满足才能进入 review；轻量修复可能在此结束）

- [ ] 全量测试命令已执行，结果已记录。
- [ ] 新增逻辑至少有一条测试直接覆盖。
- [ ] 已运行 `--gaps` 测试缺口提示，或在 `test.md` 说明无法运行的原因；提示的每个源码文件都有对应测试或明确的不测理由。
- [ ] 边界与错误路径各有验证，或有明确未覆盖说明。
- [ ] 没有“暂时跳过”的测试未说明原因。
- [ ] 手动验证项（如有）已列出，且没有伪装成自动化结果。
- [ ] 轻量修复的回归测试与 `debug.md` 记录一致（命令、修复前失败、修复后通过）。
- [ ] 轻量修复已运行 triage 并记录 `trigger`；`skipped` 时写明基线检查结论，其他触发进入 review。轻量功能与完整任务不依赖 triage，也不得因普通小 bug 的默认行为被无必要地推进 review。

## 产出

- 测试结果报告（写入对话与 `docs/devflow/<slug>/test.md`），骨架见 `templates/test-report.template.md`。
- 记录要求见 `references/evidence.md`：没有实际执行的结果不得写成通过。
- `.claude/.devflow-state.json` 中的通过记录。
- 轻量修复未标记 `review: required` 时，`test.md` 就是该任务的最终产物。

## 边界

- 不删除、跳过失败的测试来“通过”。
- 不把未运行的测试写成通过。
- `--gaps` 是启发式提示：只看文件名与常见测试目录，不解析测试内容，绝不据此判定“未覆盖”或阻断交付。
- 环境缺失导致无法运行时，明确报告缺失项，而不是猜测结果。
- 不把普通小 bug 默认推进 review；轻量修复是否需要 review 由 test 阶段的 triage 按实际 diff 判定，`debug.md` 顶部的 `review: required` 是显式要求并优先于跳过结论。
