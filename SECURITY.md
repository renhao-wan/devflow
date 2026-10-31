# 安全策略

## 支持范围

| 版本 | 支持 |
| --- | --- |
| 1.2.x | 是 |
| < 1.2 | 否，请先升级 |

## 报告漏洞

请**不要**用公开 issue 报告安全问题。使用 GitHub 的私密漏洞报告：

<https://github.com/renhao-wan/devflow/security/advisories/new>

报告时请尽量附上：受影响的版本、复现命令或最小仓库、实际影响（能绕过哪道门禁、能写哪些文件），以及是否已在真实项目触发。我们会在 7 天内确认，并在修复发布后于 `CHANGELOG.md` 中说明。

## 安全模型与边界

devflow 是**开发工作流插件**，不是运行时沙箱。理解下面的边界比期待它"防住一切"更重要。

### 信任模型

- 插件脚本、hooks、生成的 loader 都以**当前用户权限**运行，不做提权，也不降低权限。
- 项目 `.claude/hub/` 与 `.devflow.json` 属于**可信输入**：其中一个被篡改，等价于本项目被人改了构建脚本。跨项目共享 hub 前请先审查内容。
- `pluginSourceRoot` 只在通过 `isValidPluginRoot` 校验（存在 `.claude-plugin/plugin.json`）后才用于加载与回灌；回灌写入前还会拒绝 marketplace 安装缓存路径。

### `guard-dangerous` 是尽力拦截

`PreToolUse(Bash)` 钩子基于**正则与分词**识别危险命令，用于减少误操作，**不是安全边界**：

- 已做引号感知的分词，引号内的文本不会触发命令类规则；并递归检查 `sh/bash -c`、`pwsh -Command`、`cmd /c`、`eval`、`xargs rm`、`find -exec rm`。但变量展开、`$(...)`、命令别名、`/bin/rm` 的符号链接、`--no-preserve-root`、脚本文件里再执行命令等写法仍可能绕过。
- 它无法分析命令的真实语义，也无法阻止通过其他工具（编辑器、`Write`、外部程序）造成的影响。
- 不要把它当作备份、权限控制或审计的替代品。

若需要强隔离，请在该层之外使用操作系统权限、容器或审阅流程。

### hooks 失败时放行

四个钩子（`guard-dangerous`、`track-changes`、`check-tests`、`load-hub`）遵循 **fail-open**：自身异常、输入非 JSON、超时都会静默放行，避免把正常开发卡死。这意味着钩子**崩溃时不会阻止操作**——这是有意的取舍。

### 凭据处理

- `/devflow:ship` 仅在存在 `GITHUB_TOKEN` / `GH_TOKEN` 或已登录的 `gh` 时才创建 PR；token 只用于 GitHub API 请求，不写入仓库、日志或 `.devflow.json`。
- 回灌分类会把绝对路径、内网 IP、`.corp` / `.internal`、blocklist 关键词、子项目名以及常见密钥/凭据（`sk-`、`ghp_`、`github_pat_`、`AKIA`、`xox*-`、私钥、`Bearer`、URL 凭据、`password=` 等）标为项目专属，命中时**不回显原文**；但这是启发式判断，提交回灌 PR 前仍需人工审阅 diff。

### 依赖与供应链

- 运行时与测试均无第三方依赖，无需 `npm install`，不执行安装脚本。
- 插件通过 Claude Code 的 `/plugin marketplace add` 安装；升级走 `/plugin update`。建议只从你信任的仓库添加 marketplace。

## 加固建议

1. 升级完成后运行 `/devflow:doctor`，确认投影无漂移、loader 齐全。
2. 回灌与 `ship` 前用 `--dry-run` 预览将要提交的文件。
3. 在 CI 中把 `node --test` 与分支保护设为必需检查，避免未经审查的推送进入主分支。
4. 对高价值仓库保留独立备份与访问控制；不要依赖插件的钩子来保护数据。
