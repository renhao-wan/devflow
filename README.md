# devflow

Claude Code 的六阶段工程工作流插件：需求、计划、实现、测试、评审、调试。

核心思路只有一句：**规范正文只放一份（项目 `.claude/hub/`），Claude Code 看到的只是薄壳投影。**

## 特性

- **六个阶段**：`req → plan → implement → test → review`，测试或实现失败时进入 `debug` 并回到 `test`；每个阶段都有明确产出与硬门禁。
- **单一真源**：项目规则只维护 `.claude/hub/`；`.claude/skills/devflow-*` 是生成物，不手改。
- **阶段资源**：每个阶段可带 `references/`（细则）与 `templates/`（产出骨架），按需读取，避免把长清单塞进主文件。
- **多根工作区**：自动探测 `services/api` 这类两层子项目，Maven `<modules>` 展开为模块级条目，测试命令统一从工作区根执行。
- **安全门禁**：系统级破坏命令直接拒绝，有丢数据风险的操作要求确认，未测试改动只提醒不阻止。
- **可回灌**：项目里打磨过的阶段规则可以回灌到插件模板，自动识别项目专属内容。
- **可升级**：插件升级后用 `/devflow:sync` 非破坏性同步模板；手改过的文件保留并可备份。

## 前置要求

- Claude Code（支持 `/plugin` 命令）。
- Node.js：**>= 20.11**（测试使用了 `import.meta.dirname`）。
- `node` 可在 `PATH` 中找到（hooks 通过它执行）。
- 无第三方依赖，无需 npm install。

## 安装

从 GitHub 安装：

```bash
# 在 Claude Code 中把仓库加入 marketplace
/plugin marketplace add renhao-wan/devflow

# 安装插件
/plugin install devflow@devflow-marketplace
```

如果是在本机修改插件本身，也可以把本地仓库路径传给 `/plugin marketplace add`。

无需发布到公开市场，也不需要 npm。安装或修改 hooks 后需要重启 Claude Code 会话生效。

## 快速开始

### 1. 初始化工作区

在工作区根目录执行：

```bash
/devflow:init
```

会完成：

1. 创建 `.claude/hub/`，复制六个阶段的模板（含 `references/`、`templates/`）。
2. 写入 `hub.yaml`，自动探测子项目、包管理器与测试命令。
3. 在 `scripts/` 放四个薄 loader（`devflow-gen` / `devflow-doctor` / `devflow-upstream` / `devflow-test`）。loader 是生成物，会写进 `.gitignore`，换机器或重跑 init 时自动重建。
4. 生成 `.claude/skills/devflow-*` 投影。
5. 写入 `.gitignore` 片段（用标记块原地更新，重复运行不会叠加），忽略生成物与 loader。

初始化后请检查 `.claude/hub/hub.yaml`，尤其是自动探测的测试命令。看到 `.claude/skills/devflow-*` 投影即表示初始化成功。

### 2. 走一遍流程

以 `add-login` 为例（下文假设 slug 为 `add-login`）：

```bash
/devflow:req 给登录页增加短信验证码
/devflow:plan add-login
/devflow:implement add-login
/devflow:test add-login
/devflow:review add-login
```

产物默认写入 `docs/devflow/add-login/`：

```
req.md      # 目标、验收标准、边界、影响面
plan.md     # 方案、任务拆分、测试策略、回滚
test.md     # 命令、结果、覆盖、未覆盖项
review.md   # 阻断项、建议项、测试缺口、结论
debug.md    # 现象、根因、修复、验证（进入 debug 时）
```

小改动可以合并阶段（如 `req + plan`），但**不能跳门禁**：没有验收标准不实现，没有测试结果不审查。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/devflow:init [--force] [--source-root <插件源码仓库>]` | 初始化工作区 hub，探测子项目与测试命令 |
| `/devflow:req <需求>` | 需求澄清，产出 `req.md` |
| `/devflow:plan <slug>` | 方案设计，产出 `plan.md` |
| `/devflow:implement <slug>` | 按计划小步实现，测试先行 |
| `/devflow:test <slug>` | 运行与补充测试，记录真实结果 |
| `/devflow:review <slug>` | 差异导向审查，输出阻断项与建议项 |
| `/devflow:debug <问题>` | 系统化排障，先复现后修复 |
| `/devflow:doctor [--json]` | 体检版本、投影、资源、hooks、测试状态 |
| `/devflow:upstream --stage <stage> [--apply] [--bump patch\|minor\|major]` | 把项目经验回灌到插件模板 |
| `/devflow:ship --stage <stage> [--bump patch\|minor\|major] [--dry-run]` | 回灌后提交到分支、推送并生成 PR |
| `/devflow:sync [--dry-run] [--force]` | 插件升级后非破坏性同步阶段模板 |

## 六个阶段

| 阶段 | 职责 | 关键门禁 |
| --- | --- | --- |
| req | 把模糊诉求变成可验证需求 | 验收标准可观察；写明本次不做；影响面具体 |
| plan | 方案、任务拆分、测试策略、回滚 | 引用真实文件；任务可独立验证；有回滚 |
| implement | 按计划小步实现，优先 TDD | 每步可运行；无无关改动；计划与实际同步 |
| test | 真实运行测试并记录证据 | 全量已跑；改动有直接覆盖；未运行不得写通过 |
| review | 按风险审查差异 | 无未处理阻断项；敏感信息扫描通过 |
| debug | 复现、定位根因、补回归测试 | 有复现；根因有证据；回归测试修复前失败 |

每个阶段的完整规则在 `.claude/hub/stages/<stage>/SKILL.md`，执行前必须完整读取。

## hub.yaml 配置

```yaml
version: 1
requiresPlugin: "^1.0.0"

stages:
  - req
  - plan
  - implement
  - test
  - review
  - debug

subprojects:
  api:
    path: services/api
    stages: [plan, implement, test, review, debug]
    testCommand: "cd services/api && pnpm run test"
  worker:
    path: services/worker
    stages: [plan, implement, test, review, debug]
    testCommand: "cd services/worker && npm run test"

defaults:
  testCommand: "pnpm run test"
  reviewRequired: true

upstream:
  blocklist: []
```

| 字段 | 说明 |
| --- | --- |
| `version` | 配置格式版本，当前为 `1` |
| `requiresPlugin` | 插件版本范围，支持 `^` `~` `>=` `<=` `>` `<` `=` 和 `*`；不满足时生成器拒绝写入 |
| `stages` | 启用的阶段及顺序；为空时回退扫描 `stages/` 目录 |
| `subprojects.<name>.path` | 子项目相对工作区根的路径 |
| `subprojects.<name>.stages` | 该子项目适用的阶段 |
| `subprojects.<name>.testCommand` | 必须能从工作区根执行；init 会生成 `cd <rel> && ...`。探测只是初判，需按实际复核 |
| `defaults.testCommand` | 没有子项目级命令时使用。根目录无构建文件时 init 会回退为 `npm test`，需要手动修改 |
| `defaults.reviewRequired` | 流程约定字段，当前不参与脚本校验 |
| `upstream.blocklist` | 回灌时用于识别项目专属内容的额外关键词 |

## 阶段资源：references/ 与 templates/

项目真源目录结构：

```
.claude/hub/stages/<stage>/
├─ SKILL.md          # 阶段规则正文
├─ references/       # 按需读取的细则（可选）
└─ templates/        # 产出骨架（可选）
```

- `SKILL.md` 中的相对引用以该文件所在目录为基准。
- 生成器会把资源清单写入投影的 `## 阶段资源`，并记录到 `.claude/.hub-manifest.json`。
- 增删资源后需要重新运行 `node scripts/devflow-gen.mjs`；`--check` 会把它识别为漂移。
- `/devflow:doctor` 会校验账本中的资源是否仍然存在。
- 回灌时 `references/`、`templates/` 会被递归处理并保留相对路径。

## 单一真源与投影

```
插件出厂模板 templates/
        │ init 复制
        ▼
项目 .claude/hub/（唯一可编辑的规则）
        │ gen 生成
        ▼
项目 .claude/skills/devflow-*（薄壳，勿手改）
```

改规则的流程：

1. 编辑 `.claude/hub/stages/<stage>/SKILL.md`（必要时增删 `references/`、`templates/`）。
2. 运行 `node scripts/devflow-gen.mjs`。
3. 运行 `node scripts/devflow-doctor.mjs` 确认无漂移、无缺失资源。

生成器会：

- 用 SHA-256 账本检测投影漂移；
- 清理账本中已移除阶段的过期投影；
- 拒绝在 `requiresPlugin` 不满足时写入；
- 默认不覆盖不受 devflow 管理的同名技能，`--force` 才覆盖。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--root <path>` | 指定工作区根；默认向上查找 `hub.yaml` |
| `--check` | 只检查漂移，有漂移时退出码为 1 |
| `--dry-run` | 显示将写入/删除的内容，不落盘 |
| `--json` | 输出 JSON 报告 |
| `--force` | 覆盖非受管或已存在的投影 |
| `--no-plugin` | 跳过插件版本检查（离线或仅生成时使用） |

## 安全门禁与 hooks

`guard-dangerous` 在安装插件后对所有项目的 Bash 命令生效；`track-changes`、`check-tests`、`load-hub` 只在包含 `.claude/hub/hub.yaml` 的工作区生效，不会向其他项目写入状态或注入上下文。

| 事件 | 脚本 | 行为 |
| --- | --- | --- |
| `PreToolUse(Bash)` | `guard-dangerous.mjs` | 危险命令 `deny` 或 `ask` |
| `PostToolUse(Edit/Write/MultiEdit)` | `track-changes.mjs` | 记录改动文件，标记待验证 |
| `Stop` | `check-tests.mjs` | 有改动但未验证通过时提醒，从不阻止 |
| `SessionStart` | `load-hub.mjs` | 注入阶段、子项目与投影漂移摘要 |

### 直接拒绝（deny）

系统级或不可恢复的破坏，例如：

- `rm -rf /`、`rm -rf ~`、`rm -rf *`（含 `rm -fr *`、`rm -r -f *`、`rm --recursive --force *` 等选项乱序或长选项写法）；
- `mkfs`、`fdisk`、`dd of=/dev/sda`；
- `curl ... | bash`、`wget ... | sh`；
- 强推 `main` / `master` / `release/*`，以及 `git push origin +main`、`git push origin :main` 这类等价的强推/删远端分支写法；
- `DROP DATABASE`、`TRUNCATE TABLE`；
- Windows 下递归删除盘符根（`rd /s /q C:\`、`del /f C:\`）、`diskpart`、`cipher /w`、`vssadmin delete shadows`、`Format-Volume`；
- `shutdown`、`reboot`。

### 要求确认（ask）

常见但可能丢数据的操作，例如：

- `git push --force`（非保护分支）、`git reset --hard`、`git clean -fdx` / `git clean --force`；
- `git checkout .`、`git restore .`、`git branch -D` / `git branch --delete --force`；
- `git update-ref -d`、`git filter-branch`、`git push --mirror`、`git reflog expire`；
- 删除远端分支（`git push origin :feature`）、`npm publish`；
- `docker rm -f`、`docker system prune`、`kubectl delete`、`helm uninstall`；
- 删除数据库列、回滚迁移；
- `rm -rf <路径>`（含 `rm -fr <路径>`、`rm --recursive --force <路径>`）。

hooks 自身异常时一律放行（fail-open），避免把正常操作挡死。修改 hooks 或插件后需要重启会话。

> `guard-dangerous` 是**基于正则的尽力拦截**，不是安全沙箱：引号包裹、变量展开、`--no-preserve-root`、`/bin/rm` 等写法可能绕过。它的作用是减少误操作，不能替代权限控制与备份。

## 多根工作区

- 只从工作区根初始化，子项目不单独初始化 hub。
- 共享规则放在根 hub；子项目差异放进 `.claude/hub/overrides/<sub>/<stage>.md`（手动创建，生成器会在投影中提示优先读取）。
- init 从工作区根向下探测最多两层。固定跳过 `.git`、`.claude`、`.idea`、`.vscode`、`node_modules`、`dist`、`build`、`target`、`scripts`、`templates`、`docs`、`coverage` 这些目录名；若真实模块恰好命名为 `scripts`/`templates`/`docs`，它不会被识别为子项目，需要在 `hub.yaml` 手动补充。
- 目录名命中 `demand`/`require`/`design`/`spec`/`doc`（大小写不敏感）时按“需求文档目录”处理：只赋 `req` 阶段且不探测测试命令，避免把文档目录当成可构建单元。
- **探测在第一个"像项目"的目录处停止下钻。** 判定依据：目录含 `.git`、`package.json`、`pom.xml`、`build.gradle`、`go.mod`、`Cargo.toml` 或 `pyproject.toml` 之一。命中后该目录本身就是子项目，其内部不会再被扫描。
- 名称重复的子项目会用路径生成唯一名（如 `services-api`）。
- 包管理器按 `packageManager` 字段或 lockfile 向上探测（pnpm / yarn / bun / npm）。
- 测试命令按项目类型探测：`package.json` 的 `scripts.test`、`mvn test`、`./gradlew test` / `gradlew.bat test`、`go test ./...`、`cargo test`、`pytest`。
- **Maven 多模块会展开**：父 `pom.xml` 的 `<modules>` 会逐个成为独立子项目（最多两层），命令形如 `cd service/core && mvn test`；父 pom 不再单独成项，避免一次跑全量。
- 探测不到测试命令时 init 会警告，请手动补充 `testCommand`。

### init 只生成骨架，`hub.yaml` 需要人工复核

`hub.yaml` 是项目真源，init 的探测只是一次初判。以下情况必须手动修改：

1. **根目录没有构建文件**：`defaults.testCommand` 会回退成 `npm test`，与实际无关，必须改掉或换成显式占位。
2. **容器目录自身带 `.git`**：例如工作区根下有 `business-systems/`（独立 Git 仓库），真正的项目是 `business-systems/meeting-booking/`。由于探测在 `business-systems` 处命中 `.git` 并停止下钻，`meeting-booking` 不会被发现，`business-systems` 会得到一条没有 `testCommand` 的条目。

   两种修正方式任选其一：

   ```yaml
   # 方式 A：保留容器条目，把深层项目的测试命令写进去
   subprojects:
     business-systems:
       path: business-systems
       stages: [plan, implement, test, review, debug]
       testCommand: "cd business-systems/meeting-booking && mvn test"
   ```

   ```yaml
   # 方式 B：去掉容器条目，直接指向真实子项目
   subprojects:
     meeting-booking:
       path: business-systems/meeting-booking
       stages: [plan, implement, test, review, debug]
       testCommand: "cd business-systems/meeting-booking && mvn test"
   ```

   方式 B 更贴近"一个条目对应一个可构建单元"，推荐优先使用；只有在容器层确实需要统一管理时才用方式 A。

3. **多模块 Maven/Gradle 仓库**：Maven 的 `<modules>` 已自动展开为模块级条目。若父 pom 有额外聚合逻辑（profile、`-pl` 组合、插件绑定），仍需人工确认命令是否符合预期；Gradle 多项目同理，必要时改成 `./gradlew :core:test`。

改完执行：

```bash
node scripts/devflow-gen.mjs
node scripts/devflow-doctor.mjs
```

`doctor` 会校验 `hub.yaml` 语法与阶段名、投影与资源、`testCommand` 用到的工具是否在 `PATH` 中，并检查 `testCommand` 里的 `cd` 目标目录、`./gradlew` 等本地脚本是否存在，以及 `.gitignore` 片段与四个 loader 是否齐全；但它不会判断命令是否符合项目实际，`testCommand` 仍需由人确认。

## 回灌

```bash
# 预览：显示分类与 diff，不写文件
/devflow:upstream --stage plan

# 确认后写入插件模板，默认 bump patch 版本并更新 CHANGELOG
/devflow:upstream --stage plan --apply

# 指定版本升级幅度
/devflow:upstream --stage plan --apply --bump minor

# 从 marketplace 安装时，运行时插件根在安装缓存里；需显式指定源码仓库
/devflow:upstream --stage plan --plugin-root D:/projects/devflow --apply
```

回灌目标必须是**插件源码仓库**。安装缓存（`~/.claude/plugins/cache/...`）会在升级时被覆盖，脚本会直接拒绝写入。若不想每次都传 `--plugin-root`，在项目根执行一次：

```bash
/devflow:init --source-root D:/projects/devflow
```

`--source-root` 会写入 `.devflow.json` 的 `pluginSourceRoot`，之后 `upstream` 与 `ship` 自动使用它；显式 `--plugin-root` 仍然优先。

分类规则：

- `[可回灌]`：通用内容，可以进入插件模板。
- `[项目专属]`：命中绝对路径、`192.168.x.x` / `10.x.x.x` / `172.16.x.x`–`172.31.x.x` 等内网地址、`.corp` / `.internal`、`upstream.blocklist` 关键词或子项目名，不会回灌。子项目名按词边界匹配，`api` 不会误伤 `rapid` / `capital`；中文等非 ASCII 名称按普通包含处理。

`--apply` 会：

1. 递归复制有变化的可回灌文件到 `templates/stages/<stage>/`，保留相对路径；与插件一致的文件跳过且不重复 bump 版本；
2. 追加 `templates/stages/_feedback-log.md`；
3. 按 `--bump`（`patch` 默认 / `minor` / `major`）同步升级三处版本号：`.claude-plugin/plugin.json`、`package.json`、`.claude-plugin/marketplace.json` 的 `plugins[].version`；`metadata.version` 作为市场自身元数据一并更新；
4. 更新 `CHANGELOG.md`。

回灌会修改插件仓库，建议单独提交并在回灌后运行 `/devflow:doctor`。

## 升级插件

`/plugin update devflow` 之后，新版本会装到新的缓存目录，项目 `.devflow.json` 里记录的旧路径随即失效。项目里的阶段模板仍是旧版，需要同步：

```bash
# 预览：哪些会更新、哪些因手改而冲突
/devflow:sync --dry-run

# 执行：更新未改过的文件，跳过手改文件，然后重新生成投影
/devflow:sync
```

判定依据是 `.claude/.hub-sources.json`：它记录上次 init/sync 落盘时的文件哈希。同步读取的是**当前安装的插件版本**，不会从 `pluginSourceRoot` 拉未发布模板。

| 情况 | 行为 |
| --- | --- |
| 本地文件与模板完全一致 | 更新为新模板 |
| 本地文件哈希与账本一致（未手改） | 更新为新模板 |
| 本地文件被手改 | 跳过并报告冲突，本地内容保留 |
| 模板新增的资源文件 | 直接补入 |
| 模板已删除的文件 | 账本移除，本地保留（不删你的内容） |
| 本地缺少账本（老版本 init） | 一律按“可能手改”处理，只报告冲突 |

确认要用手改内容覆盖冲突文件时加 `--force`，覆盖前会在原文件旁生成 `.bak-<时间戳>` 备份。**不要用 `--force` 重跑 `init`**：那会覆盖 `hub.yaml`，而 `sync` 从不改 `hub.yaml` 与 `overrides/`。

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

`/devflow:upstream --apply` 只写本地文件，不提交。要用 PR 的方式把回灌结果送出去，用 `/devflow:ship`：

```bash
# 预览：显示分支名、将提交的文件、版本变化，不写文件
/devflow:ship --stage plan --plugin-root D:/projects/devflow --dry-run

# 执行：回灌 → 建分支 → 提交 → 推送 → 生成 PR
/devflow:ship --stage plan --plugin-root D:/projects/devflow

# 以 minor 版本升级
/devflow:ship --stage plan --plugin-root D:/projects/devflow --bump minor
```

回灌目标必须是**插件源码仓库**（含 `.git`）。已安装的插件缓存没有 git 历史，无法提 PR。

PR 创建按优先级降级：

| 方式 | 条件 | 结果 |
| --- | --- | --- |
| `gh` CLI | 已安装并登录 | 自动创建 PR，返回链接 |
| GitHub API | 设置了 `GITHUB_TOKEN` 或 `GH_TOKEN` | 自动创建 PR，token 需有 `repo` 权限 |
| compare 链接 | 两者都没有 | 输出链接，在浏览器里点一次 |

安装 `gh`（Windows）：

```bash
winget install --id GitHub.cli
gh auth login --web
```

安全约束：

- 只提交白名单文件：`templates/stages/`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`package.json`、`CHANGELOG.md`。
- 这些文件在回灌前必须干净，否则脚本拒绝执行，避免把无关改动混进 PR。
- 工作区其他未提交改动不会进入提交，脚本会列出来。
- 分支名重名时自动加 `-2`、`-3` 后缀，同时检查本地与 `origin` 上的同名分支。
- `git push` 失败时保留本地分支和提交，并切回执行前的分支，不自动删除。

## 脚本参考

| 脚本 | 作用 | 常用参数 |
| --- | --- | --- |
| `scripts/hub-init.mjs` | 初始化工作区 | `--root` `--force` `--plugin-root` `--source-root` |
| `scripts/gen-claude-skills.mjs` | 生成投影与账本 | `--root` `--check` `--dry-run` `--json` `--force` `--no-plugin` |
| `scripts/hub-doctor.mjs` | 体检配置、版本、投影、资源、hooks、测试命令依赖与 cd 目标 | `--root` `--json` |
| `scripts/hub-upstream.mjs` | 回灌阶段模板 | `--stage` `--apply` `--bump` `--root` `--plugin-root` |
| `scripts/hub-ship.mjs` | 回灌 + 分支 + 提交 + 推送 + PR | `--stage` `--plugin-root` `--base` `--bump` `--dry-run` `--no-pr` |
| `scripts/hub-sync.mjs` | 插件升级后同步阶段模板 | `--dry-run` `--force` `--no-gen` `--plugin-root` |
| `scripts/mark-test.mjs` | 记录测试通过时间与命令 | `--root` `--command` |

项目内初始化后会生成同名薄 loader：`scripts/devflow-gen.mjs`、`devflow-doctor.mjs`、`devflow-upstream.mjs`、`devflow-test.mjs`，它们指向插件内的真实脚本。loader 属于生成物，会被写进 `.gitignore`；换机器或重跑 `/devflow:init` 时自动重建。加载顺序为 `.devflow.json` 的 `pluginRoot` → `pluginSourceRoot` → 当前会话的 `CLAUDE_PLUGIN_ROOT`，任一可用即可。

## 目录结构

插件自带：

```
.claude-plugin/        # plugin.json + marketplace.json
commands/              # /devflow:* 十一个命令
skills/                # 五个通用技能（流程、TDD、评审、排障、hub 管理）
agents/                # 评审、测试、排障三个子代理
hooks/                 # 四个钩子脚本、hooks.json 与共用 lib.mjs
templates/             # init 时复制到项目的阶段模板
references/            # 评审清单、测试与排障指南
scripts/               # init / gen / doctor / upstream / ship / sync / mark-test
scripts/lib/           # 共用：路径归一化、YAML 解析、版本与 semver
tests/                 # node:test 测试
.github/               # GitHub Actions 与 PR 模板
docs/design.md         # 设计文档
SECURITY.md            # 漏洞报告与安全边界
LICENSE                # MIT
package.json           # 发布元数据与 npm test 脚本
```

项目内由 init 生成：

```
.claude/hub/           # 项目真源
├─ hub.yaml            # 子项目、阶段、测试命令
├─ stages/<stage>/     # 六个阶段的正文与资源
│  ├─ SKILL.md
│  ├─ references/      # 按需读取的细则（可选）
│  └─ templates/       # 产出骨架（可选）
├─ overrides/          # 子项目级覆盖（可选）
└─ _shared/            # 跨阶段共用规则

.claude/skills/        # 生成物，勿手改
.claude/.hub-manifest.json   # 生成账本（哈希与资源清单）
.claude/.hub-sources.json    # 阶段源文件账本，供 sync 判断是否手改
.claude/.devflow-state.json  # 测试状态
scripts/               # 薄 loader，指向插件内的真实脚本
.devflow.json          # 插件位置、版本与回灌源码根
```

## 开发与测试

```bash
node --test
```

不带路径参数，由 Node 在仓库内自动发现 `**/*.test.mjs`。不要写 `node --test tests/`：Node 22.x 起目录参数不再被当作搜索目录，而会当模块路径执行并报 `MODULE_NOT_FOUND`。

- 测试使用 `node:test`，无外部依赖；当前共 86 项，覆盖脚本、hooks、清单一致性与端到端链路。
- 运行测试需要 Node >= 20.11；插件运行本身 Node >= 18 即可。
- 改动约定：项目规则只编辑 `.claude/hub/`；插件开发时编辑插件源码与 `templates/`。不要手改生成的 `.claude/skills/devflow-*`。
- 修改模板或 hub 配置后，依次运行 `node scripts/devflow-gen.mjs` 与 `node scripts/devflow-doctor.mjs`。

CI 由 `.github/workflows/test.yml` 驱动，在 push 到 `main` 和 PR 时运行：

- `syntax`：Node 18 / 22 下对所有受版本控制的 `*.mjs` 执行 `node --check`，并逐个解析 `*.json`；
- `test`：Ubuntu Node 20 / 22、Windows Node 22（matrix 排除了 Windows + Node 20），执行 `node --test`；
- `smoke`：在 Linux 与 Windows 的临时目录执行 `init → gen --check → doctor`，并确认 loader 已生成且被 `.gitignore` 忽略。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `找不到 devflow 插件目录` | 先运行 `/devflow:init`，或检查 `.devflow.json` 中的 `pluginRoot`；升级后旧缓存失效时，会依次回退到 `pluginSourceRoot` 与当前会话的 `CLAUDE_PLUGIN_ROOT` |
| `回灌目标落在安装缓存` | 插件是从 marketplace 安装的；用 `--plugin-root <插件源码仓库>`，或运行一次 `/devflow:init --source-root <插件源码仓库>` |
| `hub.yaml 解析失败` | 使用 YAML 子集：注释、嵌套 map、块列表、行内 `[a, b]`、标量；检查缩进与冒号 |
| 投影漂移 / 手改提示 | 改源文件后运行 `node scripts/devflow-gen.mjs`，不要改投影 |
| 账本中有过期技能 | 运行 `node scripts/devflow-gen.mjs` 自动清理 |
| doctor 报阶段资源缺失 | 恢复资源文件，或重新生成；必要时从插件模板复制 |
| doctor 报测试命令依赖缺失 | `testCommand` 用到的工具不在 `PATH`；安装工具或修正命令 |
| doctor 报 `cd` 目录或本地脚本不存在 | `testCommand` 里的路径与实际目录不符；修正 `hub.yaml` 的 `testCommand` |
| `scripts/devflow-*.mjs` 不见了 | loader 是生成物且被 `.gitignore` 忽略；重跑 `/devflow:init` 或 `node scripts/devflow-gen.mjs` 即可重建 |
| 生成器报阶段名非法 | `.claude/hub/stages/` 下的目录名必须以小写字母开头，只允许 `[a-z0-9_-]` |
| hooks 不生效 | 确认项目含 `.claude/hub/hub.yaml`；重启会话；确认 `node` 在 `PATH` |
| 插件已安装但命令报 `Unknown command` | `~/.claude/settings.json` 的 `enabledPlugins` 缺少 `"devflow@devflow-marketplace": true`；补上后重启会话。若使用 cc-switch，切换供应商会整体覆盖 `settings.json`，需把该启用项同步进各供应商快照 |
| 测试命令为空或错误 | 手动修改 `hub.yaml` 的 `testCommand`；root 无构建文件时默认写 `npm test`，必须替换 |
| 升级后模板还是旧的 | 运行 `/devflow:sync --dry-run` 查看是否有冲突；手改文件需确认后加 `--force` |
| 老项目没有新阶段资源 | 运行 `/devflow:sync` 补充模板新增的资源；`--force` 重跑 init 会覆盖 `hub.yaml`，不推荐 |
| 子项目识别错误 | 检查 `hub.yaml` 的 `subprojects`。含 `.git` 的容器目录会阻止下钻，深层项目需按「多根工作区」小节手动补充或改指向 |

## 版本与兼容

`plugin.json` 是插件版本的权威来源；另外两处是镜像，必须与之一致（`tests/manifest.test.mjs` 会校验）：

- 权威来源：`.claude-plugin/plugin.json` 的 `version`（当前 `1.2.1`）
- 包元数据：`package.json` 的 `version`
- 市场条目：`.claude-plugin/marketplace.json` 中同名插件的 `plugins[].version`

`marketplace.metadata.version` 是市场自身的元数据，`upstream` / `ship` 会一并同步，但它不决定插件安装版本。

回灌与 `ship` 的 `--apply` 会同时更新以上位置；手工改版本时也要保持同步。

其他记录：

- 项目要求：`hub.yaml` 的 `requiresPlugin`
- 生成账本：`.claude/.hub-manifest.json`
- 源文件账本：`.claude/.hub-sources.json`

升级插件后先运行 `/devflow:sync --dry-run` 与 `/devflow:doctor`。版本不满足时，生成器会拒绝写入；此时要么调整 `requiresPlugin`，要么回退插件版本。

## 卸载

```bash
/plugin uninstall devflow
rm -rf .claude/hub .claude/skills/devflow-* .claude/.hub-manifest.json .claude/.hub-sources.json .claude/.devflow-state.json scripts/devflow-*.mjs .devflow.json
```

`.claude/` 下你自己写的其他技能不受影响。`.claude/hub/` 是项目真源，删除前请确认其中的规则已备份或不再需要。

## 设计文档与安全

架构取舍与分层说明见 `docs/design.md`；安全边界与漏洞报告方式见 `SECURITY.md`。

## 许可

MIT，见 `LICENSE` 与 `.claude-plugin/plugin.json`。
