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
   - 冲突：项目里手改过，默认**不覆盖**；
   - 覆盖：仅 `--force` 时出现，会先写 `.bak-<时间戳>` 备份；
   - 不兼容：模板引用了当前插件未提供的 loader，或 `minPluginVersion` 高于当前插件；这类文件**不写入**，本地内容保持不变；
   - 高优先库删除同名文件时自动回落到下一来源，不会误删项目文件。
3. 输出里的 `[team]` / `[personal]` / `[upstream]` 表示该文件当前来自哪个库；账本 `.claude/.hub-sources.json` 为 v3，记录每个文件的 `{ base, local, source }`。
4. 用户确认后去掉 `--dry-run` 执行。同步只改 `.claude/hub/stages/` 与 `.claude/hub/_shared/`，不会改动 `hub.yaml`、`overrides/`，也不会从 `pluginSourceRoot` 拉未发布模板。用 `--personal-library` / `--team-library` 传入的本机路径会写入 `.devflow.json`，下次可直接复用。
5. 同步结束会自动运行生成器；若因 `requiresPlugin` 不满足而失败，提示用户升级插件或调整版本范围。出现“不兼容”时，说明是 loader 缺失还是模板要求更高版本，建议升级插件或改用兼容来源后重跑；不要用 `--force` 强行写入。
6. 冲突较多时，提醒用户逐个对比 `.claude/hub/` 与对应来源库，不要盲目 `--force`。团队库路径不存在或未启用时，按 `/devflow:doctor` 的提示先修正 `hub.yaml` 或 clone。
