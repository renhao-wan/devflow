---
name: sync
description: 同步：把插件新版阶段模板非破坏性升级到项目 hub，保留本地手改
argument-hint: [--dry-run] [--force] [--no-gen] [--plugin-root <插件目录>]
allowed-tools: Bash(node:*), Read, Write, Edit, Glob, Grep
disable-model-invocation: true
---

执行 devflow 模板同步：**$ARGUMENTS**

1. 先预览，不写文件：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-sync.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS --dry-run
```

2. 向用户解释四类结果：
   - 新增：插件有、项目没有的文件；
   - 更新：账本记录未变、插件侧更新过的文件；
   - 冲突：项目里手改过，默认**不覆盖**；
   - 覆盖：仅 `--force` 时出现，会先写 `.bak-<时间戳>` 备份。
3. 用户确认后去掉 `--dry-run` 执行。同步只改 `.claude/hub/stages/`，不会改动 `hub.yaml`、`overrides/`。同步读取当前安装的插件版本，不会从回灌源码仓库拉未发布模板。
4. 同步结束会自动运行生成器；若因 `requiresPlugin` 不满足而失败，提示用户升级插件或调整版本范围。
5. 冲突较多时，提醒用户逐个对比 `.claude/hub/stages/` 与插件模板，不要盲目 `--force`。
