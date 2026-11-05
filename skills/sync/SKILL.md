---
name: sync
description: 同步：按来源优先级把团队库、个人库与上游插件模板非破坏性升级到项目 hub，保留本地手改
argument-hint: [--dry-run] [--force] [--no-gen] [--plugin-root <插件目录>] [--personal-library <path>] [--team-library <path>]
allowed-tools: Bash(node:*), Read, Write, Edit, Glob, Grep
disable-model-invocation: true
---

执行 devflow 模板同步：**$ARGUMENTS**

1. 先预览，不写文件：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-sync.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS --dry-run
```

2. 向用户解释结果与来源：
   - 同步按 `hub.yaml` 的 `templates.order` 读取启用的团队库、个人库与上游插件，同名文件先到先得（默认团队 > 个人 > 上游）；
   - 新增：任一来源有、项目没有的文件；
   - 更新：账本记录未变、来源侧更新过的文件；来源切换但内容相同只刷新账本；
   - 自动合并：模板与本地都改过、且能基于账本基线完成三方合并时，直接写回合并结果；合并失败才记为冲突；
   - 冲突：项目里手改过且无法自动合并，默认**不覆盖**；
   - 覆盖：仅 `--force` 时出现，会先写 `.bak-<时间戳>` 备份；
   - 不兼容：模板引用了当前插件未提供的 loader，或 `minPluginVersion` 高于当前插件；这类文件**不写入**，本地内容保持不变；
   - 草稿：模板库里的草稿不写入项目（TODO 不是规则）；项目自己的草稿即使 `--force` 也不覆盖；
   - 高优先库删除同名文件时自动回落到下一来源，不会误删项目文件。
3. 输出里的 `[team]` / `[personal]` / `[upstream]` 表示该文件当前来自哪个库；账本 `.claude/.hub-sources.json` 为 v3，记录每个文件的 `{ base, local, source }`。
4. 用户确认后去掉 `--dry-run` 执行。同步只改 `.claude/hub/stages/`、`.claude/hub/_shared/` 与 `.claude/hub/stacks/`，不会改动 `hub.yaml`、`overrides/`，也不会从 `pluginSourceRoot` 拉未发布模板。用 `--personal-library` / `--team-library` 传入的本机路径会写入 `.devflow.json`，下次可直接复用。
5. 同步结束会自动运行生成器。退出码 0 只表示同步流程正常完成，**不代表所有文件都已同步**：冲突、不兼容与草稿会保留原状并计入输出，需要按提示处理；`requiresPlugin` 不满足、参数错误或仓库异常时脚本退出码为 1。生成器报错只以警告输出、不改变同步退出码，仍需按上方提示修复。
6. 出现“不兼容”时，说明是 loader 缺失还是模板要求更高版本，建议升级插件或改用兼容来源后重跑；不要用 `--force` 强行写入。冲突较多时，提醒用户逐个对比 `.claude/hub/` 与对应来源库，不要盲目 `--force`。团队库路径不存在或未启用时，按 `/devflow:doctor` 的提示先修正 `hub.yaml` 或 clone。
