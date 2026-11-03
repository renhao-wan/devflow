# 维护与运维

面向已经把 devflow 用起来的项目，说明插件升级、阶段模板回灌、提交 PR 与常见故障处理。安装与日常使用见根目录 [README](../README.md) 与 [usage.md](usage.md)。

## 回灌

回灌把项目里打磨过的规则送回模板库。**范围**与**目标库**是两个独立维度：

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| 范围 | `--stage <name>` | 单个阶段，`.claude/hub/stages/<name>/` → `templates/stages/<name>/` |
| 范围 | `--shared` | 共享规则，`.claude/hub/_shared/` → `templates/shared/` |
| 范围 | `--all` | 所有阶段；`_shared` 存在时一并回灌 |
| 目标 | `--to personal` | 个人库（默认 `~/.claude/devflow`）：A 项目回灌，B 项目复用 |
| 目标 | `--to team` | 团队库（`hub.yaml` 配置）：团队共用模板，默认只写工作区 |
| 目标 | `--to upstream`（默认） | 上游插件源码仓库，不提交 |
| 修饰 | `--pr` | 团队库或上游库走分支 + 提交 + 推送 + PR |

三个库共用 `<root>/templates/stages/**` 与 `<root>/templates/shared/**` 布局。项目里的 `.claude/hub/` 是同步落盘目标，不作为回灌来源。

```bash
# 预览：显示分类与差异，不写文件
/devflow:upstream --stage plan

# 写入个人库（默认不 bump 版本）
/devflow:upstream --stage plan --to personal --apply

# 写入团队库：只改工作区，不提交
/devflow:upstream --stage plan --to team --apply

# 写入上游插件源码（默认不 bump 版本）
/devflow:upstream --stage plan --to upstream --plugin-root D:/projects/devflow --apply

# 上游 PR
/devflow:upstream --stage plan --to upstream --pr --apply

# 个人库 / 团队库也支持共享规则与全量
/devflow:upstream --shared --to personal --apply
/devflow:upstream --all --to team --apply
```

### 目标库路径

个人库按以下顺序解析，路径不存在时视为空库，首次回灌自动创建：

1. `--personal-library <path>`
2. 环境变量 `DEVFLOW_PERSONAL_LIBRARY`
3. `.devflow.json` 的 `personalLibraryPath`
4. 默认 `~/.claude/devflow`

团队库在 `hub.yaml` 配置，不自动 clone；路径不存在会报错并提示 clone 命令。团队库必须是本机已 clone 或 `git init` 的 **git 仓库顶层**，回灌与 `--pr` 都依赖 git：

```yaml
templates:
  order: [team, personal, upstream]   # 先出现者优先，同名文件整文件覆盖
  team:
    enabled: true
    repo: https://github.com/org/devflow-templates.git   # 仅用于提示
    base: main
    path: ../devflow-templates                           # 相对项目根，或绝对路径
  personal:
    enabled: true
```

本机路径可用 `--team-library <path>` 或 `.devflow.json` 的 `teamLibraryPath` 覆盖，优先于 `hub.yaml` 的 `team.path`。团队库路径解析顺序：`--team-library` > `DEVFLOW_TEAM_LIBRARY` > `teamLibraryPath` > `templates.team.path`。`init` / `sync` 时显式传入的 `--personal-library` / `--team-library` 会写入 `.devflow.json`，之后不用重复传；相对路径按运行时工作目录解析，`hub.yaml` 的 `path` 相对项目根。

上游库按 `--plugin-root` > `.devflow.json` 的 `pluginSourceRoot` > 运行时插件根解析。**上游回灌目标必须是插件源码仓库**；安装缓存（`~/.claude/plugins/cache/...`）会在升级时被覆盖，脚本会直接拒绝。若不想每次都传 `--plugin-root`：

```bash
/devflow:init --source-root D:/projects/devflow
```

`--source-root` 会写入 `.devflow.json` 的 `pluginSourceRoot`，之后 `upstream` 与 `ship` 自动使用它；显式 `--plugin-root` 仍然优先。


### 显式分区标记

在规则文件里用注释块精确声明哪些内容属于通用、哪些属于项目：

```markdown
<!-- devflow:reusable -->
通用规则：先写验收标准，再给方案。
<!-- /devflow:reusable -->

<!-- devflow:local -->
本项目的网关在 10.0.3.14，仅内部可用。
<!-- /devflow:local -->
```

- `devflow:local` 块整块剔除，不会进入插件。
- `devflow:reusable` 块强制保留，但仍会做敏感扫描与提交前校验。
- 没有标记的内容按行扫描：命中敏感模式的行单独剔除，其余行照常回灌。剔除后若只剩 frontmatter 或空内容，整个文件判为项目专属。

敏感模式包括绝对路径（Windows 盘符、`/Users/<name>`、`/home/<name>`）、内网地址（`192.168.x.x` / `10.x.x.x` / `172.16.x.x`–`172.31.x.x` / `127.0.0.1` / `169.254.x.x`）、`.corp` / `.internal`、常见密钥格式（`sk-`、`ghp_`、`AKIA`、`Bearer`、URL 内 `user:pass@` 等），以及 `upstream.blocklist` 关键词与子项目名。子项目名按词边界匹配，`api` 不会误伤 `rapid` / `capital`；中文等非 ASCII 名称按普通包含处理。

### 写入与回滚

写入行为由 `--to` 决定：

| 目标 | 写入位置 | 版本文件 | 提交 |
| --- | --- | --- | --- |
| `personal` | `<个人库>/templates/` | 不碰 | 不提交 |
| `team` | `<团队库>/templates/` | 不碰 | 默认不提交 |
| `upstream` | 插件源码的 `templates/` | 仅在 `--bump` 时更新 | 不提交 |

个人库与团队库的备份、journal 与日志都在各自库根：`.devflow/backups/<id>/`、`.devflow/upstream-journal.json`、`.devflow/upstream-log.jsonl`、`docs/upstream-log.md`。写入流程与上游一致：只复制有变化的可回灌文件、先备份、中断可续做。个人库与团队库没有版本文件，显式 `--bump` 会报错。

团队库额外约束：

- 必须是 git 仓库顶层；否则报错，不会写进任意子目录。
- 目标文件已有未提交改动时拒绝写入；确认放弃这些改动时加 `--force`，会先备份再覆盖。
- 其他无关的未提交改动只提示，不阻断。

上游 `--apply` 会：

1. 复制有变化的可回灌文件到 `templates/stages/<stage>/` 或 `templates/shared/`，保留相对路径；与插件一致的文件跳过；
2. 把被覆盖的旧文件备份到 `.devflow/backups/<id>/`，并写一份 journal，中断后重跑同一命令可续做；
3. 默认**不 bump** 版本；传 `--bump patch|minor|major` 时才同步更新 `.claude-plugin/plugin.json`、`package.json`、`.claude-plugin/marketplace.json` 的 `plugins[].version`（`metadata.version` 作为市场自身元数据一并更新），并写入 `CHANGELOG.md`；
4. 追加回灌日志到 `.devflow/upstream-log.jsonl` 与 `docs/upstream-log.md`。

回滚到某次回灌之前：

```bash
# 指定目标库
/devflow:upstream --to personal --revert <记录 ID>
/devflow:upstream --to team --revert <记录 ID>

# 不指定时依次在个人、团队、上游日志中查找
/devflow:upstream --revert <记录 ID>
```

记录 ID 在命令输出和对应库的 `docs/upstream-log.md` 中。个人库与团队库只恢复模板文件；上游回滚还会恢复版本文件与 CHANGELOG。团队库的 `--pr` 记录写进 PR 分支的日志，需先合并该 PR 才能在本地按 ID 回滚。

回灌会修改目标库，建议单独提交后在项目里运行 `/devflow:doctor`。

其他项目要复用这些内容，需在各自 `hub.yaml` 的 `templates.order` 中启用对应库（个人库默认启用），然后运行 `/devflow:sync`；AI 读取规则的完整时机见 [usage.md 的“AI 何时读取这些规则”](usage.md#ai-何时读取这些规则)。

## 升级插件

`/plugin update devflow` 之后，新版本会装到新的缓存目录，项目 `.devflow.json` 里记录的旧路径随即失效。项目里的阶段模板仍是旧版，需要同步：

```bash
# 预览：哪些会更新、哪些因手改而冲突
/devflow:sync --dry-run

# 执行：更新未改过的文件，跳过手改文件，然后重新生成投影
/devflow:sync
```

判定依据是 `.claude/.hub-sources.json`（schema v3）与 `.claude/.hub-bases/` 快照：账本为每个文件记录 `{ base, local, source }`，`source` 标明内容来自 `team`、`personal` 还是 `upstream`。同步按 `hub.yaml` 的 `templates.order` 读取所有启用库，同名文件先到先得、整文件覆盖；项目里的手改仍由基线快照做三方合并保留。旧项目没有 `templates` 块时只读上游，行为不变；v2 账本会在下次 `sync` 自动升级到 v3。同步不会从 `pluginSourceRoot` 拉未发布模板。`stages/` 与 `_shared/` 都会同步。

| 情况 | 行为 |
| --- | --- |
| 本地文件与模板完全一致 | 记为一致，不重写 |
| 本地文件哈希与账本一致（未手改） | 更新为新模板 |
| 模板与基线一致、本地手改 | 保留手改，只刷新账本与来源 |
| 来源切换但模板内容相同 | 保留本地内容，只把账本的 `source` 更新为高优先库 |
| 本地与模板都改过，且有基线快照 | `git merge-file` 三方合并：无冲突则写入合并结果并报告「自动合并」 |
| 三方合并冲突 | 保留本地内容并报告冲突，手工合并后重跑 |
| `--force` | 跳过合并直接用模板覆盖，覆盖前生成 `.bak-<时间戳>` 备份 |
| 模板新增的资源文件 | 直接补入 |
| 高优先库删除同名文件 | 回落到下一来源；所有库都不再提供时才从账本移除，本地文件保留 |
| 本地缺少账本（老版本 init） | 一律按“可能手改”处理，只报告冲突 |

确认要用手改内容覆盖冲突文件时加 `--force`，覆盖前会在原文件旁生成 `.bak-<时间戳>` 备份。**不要用 `--force` 重跑 `init`**：那会覆盖 `hub.yaml`，而 `sync` 从不改 `hub.yaml` 与 `overrides/`。

自动合并后请检查合并结果再提交；重复运行 `sync` 是幂等的。

### 启用状态与重启

插件「装好」和「启用」是两件事，分别记录在两个文件里：

| 文件 | 内容 | 谁维护 |
| --- | --- | --- |
| `~/.claude/plugins/installed_plugins.json` | 安装记录：路径、版本、commit | 安装器与 `claude plugin update` |
| `~/.claude/settings.json` 的 `enabledPlugins` | 本会话是否加载该插件 | `/plugin` 界面或手动编辑 |

`claude plugin update` 只更新前者和缓存目录，**不会补写 `enabledPlugins`**。所以安装或升级后：

1. 确认 `enabledPlugins` 里有 `"devflow@devflow-marketplace": true`；
2. **重启 Claude Code 会话**，命令才会注册。

如果命令突然消失（例如 `/devflow:sync` 报 `Unknown command`），而插件缓存与 `installed_plugins.json` 都正常，先查 `enabledPlugins`。

> **注意**：用 cc-switch 等工具管理模型供应商配置时，切换供应商会用其数据库里的完整 `settings.json` 快照**整体覆盖**该文件。若快照生成于插件安装之前，`enabledPlugins` 里的 devflow 会被抹掉，表现为重启后命令不再存在。
>
> 只改 `~/.claude/settings.json` 只能撑到下次切换；要长期保留，需要把 `"devflow@devflow-marketplace": true` 加进 cc-switch 中每个供应商的配置快照。

## 提交与 PR

个人库只写本地文件，不提交。团队库默认只写工作区，加 `--pr` 才提交、推送并开 PR。上游回灌用 `/devflow:ship`，或 `/devflow:upstream --to upstream --pr`（两者共用同一套计划与提交逻辑）：

```bash
# 预览：显示分支名、将提交的文件、版本变化，不写文件
/devflow:ship --stage plan --plugin-root D:/projects/devflow --dry-run

# 执行：回灌 → 建分支 → 提交 → 推送 → 生成 PR（默认不 bump 版本）
/devflow:ship --stage plan --plugin-root D:/projects/devflow

# 显式升级版本
/devflow:ship --stage plan --plugin-root D:/projects/devflow --bump minor

# 多个范围一起回灌
/devflow:ship --stage plan --stage review --shared

# fork 工作流：推到自己的 fork，PR 开向 --pr-repo
/devflow:ship --stage plan --remote myfork --pr-repo owner/devflow

# 续推已有的回灌分支（例如上次 push 失败）
/devflow:ship --resume devflow/upstream-plan-20260101120000
```

团队库 PR 复用同一套 worktree 流程，但不读取版本文件、不写 CHANGELOG：

```bash
# 预览：目标分支、将提交的模板
/devflow:upstream --to team --stage plan --pr

# 执行：建分支 → 提交 → 推送 → 开 PR
/devflow:upstream --to team --stage plan --pr --apply
```

团队库默认分支取 `hub.yaml` 的 `templates.team.base`（缺省 `main`），分支名前缀为 `devflow/team-`。也可直接调用 `/devflow:ship --profile team --plugin-root <团队库根>`。

上游 PR 目标是**插件源码仓库**（含 `.git`）；团队库 PR 目标是团队模板 git 仓库。已安装的插件缓存没有 git 历史，无法提 PR。

默认**不 bump 版本**，只更新模板与回灌日志；上游传 `--bump` 才升级三处版本号并写入 CHANGELOG。这样多次回灌可以先攒在一起，发布时统一升版。团队库没有版本文件，传 `--bump` 会直接报错。

PR 创建按优先级降级：

| 方式 | 条件 | 结果 |
| --- | --- | --- |
| `gh` CLI | 已安装并登录 | 创建或更新同 head 的 PR，返回链接 |
| GitHub API | 设置了 `GITHUB_TOKEN` 或 `GH_TOKEN` | 创建或更新同 head 的 PR，token 需有 `repo` 权限 |
| compare 链接 | 两者都没有 | 输出链接，在浏览器里点一次 |

同 head 分支已有开启中的 PR 时，`gh` 与 API 都会更新其标题与正文，不再重复创建。`--no-pr` 只推送分支。

安装 `gh`（Windows）：

```bash
winget install --id GitHub.cli
gh auth login --web
```

安全约束：

- 上游白名单：`templates/stages/`、`templates/shared/`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`package.json`、`CHANGELOG.md`、`.devflow/upstream-log.jsonl`、`docs/upstream-log.md`。
- 团队库白名单收窄为 `templates/stages/`、`templates/shared/`、`.devflow/upstream-log.jsonl`、`docs/upstream-log.md`；不会改动任何版本文件或 CHANGELOG。
- 这些文件在回灌前必须干净，否则脚本拒绝执行，避免把无关改动混进 PR。
- 工作区其他未提交改动不会进入提交，脚本会列出来。
- 提交前重新扫描写出的文件：仍含疑似密钥则停止；`SKILL.md` 的 frontmatter `name` 必须与目录名一致且 `description` 非空。
- 分支从 `--base`（默认 `main`）的本地分支或 `origin/<base>` 创建，不携带当前分支上的无关提交；使用 `origin/<base>` 时不会自动 fetch，远端刚更新过请先执行 `git fetch origin <base>`。
- 执行过程使用**临时 git worktree**：回灌、提交、推送都在临时目录完成，主工作区的当前分支与未提交改动不受影响，结束后自动清理。
- 分支名重名时自动加 `-2`、`-3` 后缀，同时检查本地与 `origin` 上的同名分支。
- `git push` 失败时保留本地分支和提交（不删除），主工作区不会切换；用 `--resume <分支>` 续推。
- 推送与错误信息会打码 URL 中的凭据和查询参数 token，避免泄露到终端或日志。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `找不到 devflow 插件目录` | 先运行 `/devflow:init`，或检查 `.devflow.json` 中的 `pluginRoot`；升级后旧缓存失效时，会优先使用当前会话的 `CLAUDE_PLUGIN_ROOT`，再回退到 `pluginSourceRoot` |
| `回灌目标落在安装缓存` | 插件是从 marketplace 安装的；用 `--plugin-root <插件源码仓库>`，或运行一次 `/devflow:init --source-root <插件源码仓库>` |
| `hub.yaml 解析失败` | 使用 YAML 子集：注释、嵌套 map、块列表、行内 `[a, b]`、标量；检查缩进与冒号 |
| 不知道当前做到哪一步 | 运行 `/devflow:status`；它只读推导阶段并给出下一步命令，不修改状态 |
| 投影漂移 / 手改提示 | 改源文件后运行 `node scripts/devflow-gen.mjs`，不要改投影 |
| 编辑投影/账本被拒绝 | `guard-generated` 阻止手改生成物；改 `.claude/hub/stages/` 后重新生成，或重跑 `/devflow:init` 刷新 loader |
| Stop 提示 hub 源改动未生成 | 运行 `node scripts/devflow-gen.mjs` 重新生成投影；之后提醒会自动消失 |
| 账本中有过期技能 | 运行 `node scripts/devflow-gen.mjs` 自动清理 |
| doctor 报阶段资源缺失 | 恢复资源文件，或重新生成；必要时从插件模板复制 |
| doctor 报测试命令依赖缺失 | `testCommand` 用到的工具不在 `PATH`；安装工具或修正命令 |
| doctor 报 `cd` 目录或本地脚本不存在 | `testCommand` 里的路径与实际目录不符；修正 `hub.yaml` 的 `testCommand` |
| `scripts/devflow-*.mjs` 不见了或内容过期 | loader 是生成物且被 `.gitignore` 忽略；重跑 `/devflow:init` 会重建并刷新旧 loader（`devflow-gen` 不负责生成 loader） |
| 生成器报阶段名非法 | `.claude/hub/stages/` 下的目录名必须以小写字母开头，只允许 `[a-z0-9_-]` |
| hooks 不生效 | 确认项目含 `.claude/hub/hub.yaml`；重启会话；确认 `node` 在 `PATH` |
| 插件已安装但命令报 `Unknown command` | `~/.claude/settings.json` 的 `enabledPlugins` 缺少 `"devflow@devflow-marketplace": true`；补上后重启会话。若使用 cc-switch，切换供应商会整体覆盖 `settings.json`，需把该启用项同步进各供应商快照 |
| 测试命令为空或错误 | 手动修改 `hub.yaml` 的 `testCommand`；root 无构建文件时默认写 `npm test`，必须替换 |
| 升级后模板还是旧的 | 运行 `/devflow:sync --dry-run` 查看是否有冲突；手改文件需确认后加 `--force` |
| 回灌后版本号没变 | 默认不 bump；需要发版时加 `--bump patch\|minor\|major`（仅上游库支持） |
| 团队库报路径不存在 | 按报错里的 clone 命令把团队模板仓库 clone 到 `templates.team.path`，或用 `--team-library` / `.devflow.json` 的 `teamLibraryPath` 指向本机已有 clone |
| 团队库目标文件有未提交改动 | 先提交或 stash；确认放弃时加 `--force`，脚本会先备份再覆盖 |
| 团队库报“必须是 git 仓库顶层” | 把 `templates.team.path` 指到仓库根，而不是子目录 |
| 个人库目录不存在 | 正常；首次 `--to personal --apply` 会自动创建，路径见 `/devflow:doctor` 输出 |
| doctor 提示模板来源账本为 v2 | 运行 `/devflow:sync` 升级到 v3，补全每个文件的 `source` |
| 想撤销某次回灌 | `/devflow:upstream --revert <记录 ID>`；ID 见命令输出或对应库的 `docs/upstream-log.md` |
| 回灌后 `SKILL.md` 校验失败 | frontmatter `name` 必须与目录名一致，`description` 不能为空；修正后重新回灌 |
| 同步显示「自动合并」 | 本地与模板都改过，已按基线三方合并；检查结果后提交，冲突文件需手工合并 |
| 找不到回灌备份 | 备份在 `.devflow/backups/<记录 ID>/`；日志在 `.devflow/upstream-log.jsonl` 与 `docs/upstream-log.md` |
| 老项目没有新阶段资源 | 运行 `/devflow:sync` 补充模板新增的资源；`--force` 重跑 init 会覆盖 `hub.yaml`，不推荐 |
| 子项目识别错误 | 检查 `hub.yaml` 的 `subprojects`。含 `.git` 的容器目录会阻止下钻，深层项目需按 [usage.md](usage.md) 的“多根工作区”小节手动补充或改指向 |
| 工具路由总是 `use-devflow` | 运行 `devflow route --detect` 刷新检测；确认 `ecosystem.yaml` 的 `routing.mode` 不是 `off`，且工具已安装 |
| 检测结果过期 | doctor 会提醒；运行 `devflow route --detect` 更新 `.claude/.ecosystem-state.json` |
| 想临时不用其他工具 | 阶段命令加 `--force-devflow`，或把 `routing.forceDevflowStages` 加入该阶段；全局关闭用 `routing.mode: off` |
| route 报未知工具 | `--tool` 的值必须匹配 `.claude/hub/ecosystem.yaml` 的 `tools` 键；未知、禁用或阶段不匹配都会退出码 1 |
