---
name: doctor
description: 体检：校验 hub 配置、版本兼容、投影一致性与 hooks 状态
argument-hint: [--json]
allowed-tools: Bash(node:*), Read, Glob, Grep
---

对当前项目运行 devflow 体检。

优先使用项目内 loader（存在时）：

```bash
node scripts/devflow-doctor.mjs $ARGUMENTS
```

不存在时直接调用插件脚本：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-doctor.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

然后：

1. 按严重程度汇总：先错误，后提醒。
2. 对每类问题给出具体修复命令（通常是 `node scripts/devflow-gen.mjs`）。
3. 全部通过时，用一句话确认，并列出检查过的项目：配置、版本、投影、hooks、测试状态。
4. 不要自行修改文件；修复由用户确认后执行。
