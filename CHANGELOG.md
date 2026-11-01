# Changelog

## 1.3.2

### 修复

- `hub-upstream` / `hub-ship` 校验阶段名并做路径包含性检查，防止通过 `hub.yaml` 或账本把文件写到 `.claude/hub/stages` 与插件模板之外
- 生成器与 `doctor` 解析账本路径时使用真实路径校验，跳过符号链接，并把 Windows 与 POSIX 的行尾差异归一化后再比较哈希
- `hub-ship` 改用临时 git worktree 完成回灌、提交与推送，主工作区不切换分支；`--base` 在写文件前校验，push 失败时保留本地分支与提交
- `track-changes` 修复 `Date.parse` 缺失时间时的 1999 年回退，记录 rename 的旧路径，并支持 `NotebookEdit` 的 `notebook_path`
- `check-tests` 对缺失或非法时间字段按“未知”处理，不再因时间回退而漏提醒或误静默
- `guard-dangerous` 识别换行分隔的复合命令、环境变量前缀与 `sudo -u` / `timeout` / `env` / `nice` 等包装器，以及 `cmd.exe /c`、`cmd //c`、`powershell -C`、`shutdown.exe`、`rd /s/q`、`Remove-Item -Rec` 等变体；拒绝原因中的 URL 凭据、token 与密码参数会脱敏
- `init` 重跑时自动刷新过期的 loader，且 loader 加载顺序优先使用当前会话的 `CLAUDE_PLUGIN_ROOT`
- `hub-sync` 兼容旧账本记录的原始哈希，仅行尾不同时不再误判为手改
- `doctor` 校验 `.claude/hub/_shared/` 的路径与哈希，发现共享规则变更时提示重新生成；测试状态同时参考 `testsPending` 与改动时间

### 增强

- 新增跨阶段共享规则目录 `.claude/hub/_shared/`，生成器会把其中每条规则注入所有阶段投影并记入账本
- 命令的 `allowed-tools` 补齐 `Task` / `Skill`；review 命令与相关技能改用 superpowers 的实际技能名 `requesting-code-review` / `receiving-code-review`
- 测试报告模板新增运行环境字段（OS / Node / 包管理器）

### 文档

- README 更新 loader 顺序、`_shared/`、ship 的临时 worktree 安全约束、CI Node 20 / 22 与测试数量
- `docs/design.md` 补充 1.3.2 里程碑

## 1.3.1

### 修复

- 生成器只把实际写入的投影记入账本；源文件出错时保留旧账本条目，过期清理跳过出错阶段，避免投影失去归属后被误删
- 非受管投影内容与生成结果一致时正常采用；内容不同时跳过并提示 `--force`，不再静默覆盖或写入账本
- `--json` 普通执行时 stdout 只输出报告，过程日志改走 stderr，便于脚本解析
- `init` / `sync` 在生成阶段出错时明确提示错误数量，不再把失败包装成“初始化/同步完成”
- `ship` 从 `--base`（本地或 `origin/<base>`）创建分支，避免把当前分支的无关提交带进 PR；远端 URL 日志做脱敏
- `track-changes` 用修改时间筛选 Bash 后的 `git status`，已有脏文件或只读命令不再误触发“测试待验证”
- `guard-dangerous` 覆盖 Windows 非根递归删除（`rd /s`、`del /s`、`Remove-Item -Recurse`），按命令位置判断避免误伤 `echo` / `grep` 文本；盘符根仍直接拒绝
- `hub-upstream` 在 CHANGELOG 标题缺失时补标题再插入；已有同版本条目时不重复写入

### 文档

- 命令入口标注“以下为入口摘要，与阶段 SKILL 冲突时以 SKILL 为准”，并补齐 TDD、测试执行、系统排障、代码审查技能与子代理引用
- plan 阶段明确吸收 superpowers 的 `brainstorming` / `writing-plans` 结论，不并存两份设计或计划
- 三个 fallback 技能补充与 superpowers 的关系说明
- README 更新 hooks 事件、Windows 递归删除的 deny/ask 说明与版本号

## 1.3.0

### 增强

- plan 阶段新增“先调研已有实现”：按小改动 / 有界 / 架构性 / 可行性探索分级决定调研深度；产出 `## 调研与复用判断`，记录检索记录、候选对比与“采用 / 借鉴 / 自建 / 排除”的理由
- 新增 `templates/stages/plan/references/prior-art-research.md`：检索方法、候选评估维度（能力、许可证、维护状态、依赖与退出成本、安全合规、迁移成本）与结论分类
- plan 新增搜索失败降级协议：WebSearch → 官方文档/仓库 → GitHub API → 本地插件/vendor/缓存 → 用户资料；有上限重试，显式标记未验证项，禁止编造来源；高风险改动检索失败时先请用户确认
- req 新增“技术约束”：是否允许新增依赖、许可证政策、运行时/版本下限、离线或私有部署、数据驻留、必须兼容接口；产出模板新增 `## 技术约束`
- review 新增“复用与依赖检查”：核对 plan 的复用判断来源、许可证与约束一致性、维护状态与已知漏洞、搜索失败披露；`review-checklist` 新增对应清单
- debug 新增可选的“查已知问题”：用完整错误、错误码与依赖版本检索官方 issue 与变更日志；外部结论只作线索，须本地复现验证
- `commands/plan|review|debug` 的 `allowed-tools` 补充 `WebSearch`、`WebFetch`；plan 额外补充 `Bash(gh:*)`；`devflow-code-reviewer`、`devflow-debug-investigator` 子代理同步获得检索能力
- `devflow-engineering-flow` 新增“与 superpowers 的协作边界”：devflow 管阶段与门禁，superpowers 管执行技法，冲突以 devflow 为准，已有计划吸收进 `plan.md`

### 文档

- README 新增“方案调研与搜索失败处理”“与 superpowers 的关系”章节，六阶段表更新 plan 门禁
- `docs/design.md` 新增方案前调研决策、superpowers 边界与 1.3.0 里程碑
- `SECURITY.md` 新增“外部调研”安全说明：外部内容不可信、不外发敏感信息、许可证以原文为准、网络调用不受 guard 保护；支持范围更新至 1.3.x

## 1.2.1

### 修复

- `guard-dangerous` 改为引号感知的分词与命令位置匹配：`git commit -m "fix reboot"`、`grep "shutdown"`、`echo "DROP DATABASE"`、`rg "format C:"`、`rm -rf ./build`、`rm -rf ~/work/tmp` 不再误拦；根目录判断只匹配精确的 `/`、`~`、`.`、`..`
- `guard-dangerous` 递归检查 `bash/sh/zsh -c`、`pwsh -Command`、`cmd /c`、`eval`、`xargs rm`、`find -exec rm`，补上 `bash -c 'rm -rf /'`、`xargs rm -rf` 等绕过
- `guard-dangerous` 的 SQL 规则只作用于 `psql` / `mysql` / `sqlcmd` 等客户端通过 `-c` / `-e` / `-Q` 传入的语句
- `track-changes` 覆盖 `Bash` 与 `NotebookEdit`：Bash 通过 `git status --porcelain` 发现 `sed -i`、格式化器、代码生成等间接改动，并过滤 `node_modules`、`dist`、`build`、`coverage` 等噪声
- `track-changes` 在 Windows 跨盘符时再次判断绝对路径，避免把项目外文件计入
- `check-tests` 同一批改动只提醒一次，减少 Stop 时重复刷屏

### 增强

- 版本模型改为 `plugin.json` 权威、`package.json` 与 `marketplace.plugins[].version` 镜像；`metadata.version` 不再作为插件版本来源，`hub-upstream` 同步写入 `plugins[].version`
- `hub-upstream` 新增密钥/凭据扫描（`sk-`、`ghp_`、`github_pat_`、`AKIA`、`xox*-`、私钥、`Bearer`、URL 凭据、`password=` 等），命中按项目专属处理且不回显原文；补充 `127.0.0.1`、`169.254/16`
- `hub-doctor` 检查 `.devflow.json` 记录的插件版本，落后时提示 `/devflow:sync`；新增阶段资源清单摘要
- `review` 阶段增加“验收对照”，逐条核对 `req.md` 验收标准与 `plan.md` 任务；review 模板新增验收对照表
- `debug` 阶段增加结论字段 `fixed` / `partial` / `unresolved`，非 `fixed` 必须写明残余风险
- `load-hub` 返回 `reloadSkills`，`/clear`、resume 后重新扫描投影；PostToolUse 增加 `NotebookEdit`，SessionStart 增加 `fork`
- 命令文档补齐 `--bump`、`--no-pr`、`--no-gen`、`--plugin-root`；`ship` 白名单说明补全 `package.json` 与 `marketplace.json`
- `engines.node` 与 README 统一为 `>= 20.11`
- 流程说明把 `debug` 画成 `test` / `implement` 的失败分支，而不是 `review` 之后的必经阶段

### 测试与 CI

- 新增 guard 误伤/嵌套、SQL 客户端、Bash 改动追踪、check-tests 节流、回灌密钥扫描、marketplace 条目版本等用例
- CI 新增插件清单校验作业：`claude plugin validate . --strict`、`claude plugin validate .claude-plugin/plugin.json --strict`、`claude plugin tag --dry-run`

## 1.2.0

### 修复

- `upstream` 子项目名与 blocklist 改为词边界匹配，`api` 不再误伤 `rapid` / `capital`；中文等非 ASCII 名称仍按普通包含处理
- 生成物（`.bak-*`、`.tmp-*`、隐藏文件）不再进入阶段资源、回灌候选与 `sync` 复制，避免把备份内容带进插件模板
- `guard-dangerous` 修复绕过：递归强制删除改为选项顺序无关并支持 `--recursive` / `--force` 等长选项；补充 `git clean --force`、`git branch --delete --force`、`git push origin +main`、`git push origin :main`
- 生成器校验阶段名（小写字母开头的 `[a-z0-9_-]`）并对投影写入做路径越界防护，拒绝写出 `.claude/skills/devflow-*` 之外的位置

### 增强

- 版本号统一种子为三处单一真源：`.claude-plugin/plugin.json`、`package.json`、`.claude-plugin/marketplace.json` 的 `metadata.version`；`upstream --apply` 与 `ship` 同时更新，新增清单一致性测试
- `upstream` / `ship` 新增 `--bump patch|minor|major`；内容与插件一致时不再重复 bump 或写 CHANGELOG
- `ship` 白名单补充 `package.json` 与 `.claude-plugin/marketplace.json`；分支名去重同时检查本地与 `origin`；push 失败时切回执行前的分支
- `hub-init` 把四个 loader 写入 `.gitignore`，并用标记块幂等更新，重复 init 不再叠加；loader 加载顺序为 `pluginRoot → pluginSourceRoot → CLAUDE_PLUGIN_ROOT`
- `hub-doctor` 新增检查：`hub.yaml` 的 `version` / 阶段名合法性 / 重复阶段 / blocklist 类型、`testCommand` 的 `cd` 目标与 `./gradlew` 等本地脚本是否存在、`.gitignore` 片段与 loader 完整性
- `hub-sync` 应用后刷新 `.devflow.json` 的 `pluginRoot` 与 `pluginVersion`，并过滤生成物
- `implement` 命令补充常用构建/测试工具到 `allowed-tools`
- `mark-test` 记录通过后清空 `testsPending`；`track-changes` 忽略账本与生成元数据
- 抽取 `scripts/lib/common.mjs` 的 `canonicalPath` / `samePath` / `isGeneratedArtifact` / `bumpVersion`，hooks 共用 `hooks/scripts/lib.mjs`，`load-hub` 复用 YAML 解析器
- 删除未使用的 `templates/hub.yaml`

### 测试与 CI

- 测试增至 77 项，新增清单一致性、guard 等价写法、回灌幂等与版本同步、PR 正文、loader 回退、生成物过滤等用例
- CI 新增 `syntax` 作业（Node 18/22 下 `node --check` 全部脚本并解析 JSON），`smoke` 覆盖 Linux 与 Windows

### 文档

- 新增 `SECURITY.md`：支持范围、漏洞报告渠道、信任模型、`guard-dangerous` 的局限与凭据处理
- README 与 `docs/design.md` 同步更新 loader 策略、doctor 检查、`--bump`、版本单一真源、ship 白名单、CI 说明

## 1.1.0

- 新增 `/devflow:sync` 与 `scripts/hub-sync.mjs`：插件升级后非破坏性同步阶段模板。未手改的文件更新，手改过的文件跳过并报告冲突，`--force` 覆盖前生成 `.bak-<时间戳>` 备份
- 新增 `.claude/.hub-sources.json` 源文件账本：记录 init/sync 落盘时的文件哈希，用于区分“未改可更新”与“手改需保留”
- 新增 `pluginSourceRoot`：`/devflow:init --source-root <插件源码仓库>` 记录回灌目标，运行时插件根与回灌目标解耦
- 回灌与 ship 拒绝写入 marketplace 安装缓存（`plugins/cache/...`），避免升级后结果丢失；插件根解析在缓存失效时优先使用当前会话的 `CLAUDE_PLUGIN_ROOT`
- Maven 多模块：init 解析父 `pom.xml` 的 `<modules>` 并展开为独立子项目（最多两层），测试命令为 `cd <模块> && mvn test`
- `doctor` 新增 `testCommand` 依赖工具检查（npm / pnpm / yarn / bun / mvn / gradle / go / cargo / dotnet / pytest 等），缺失时提示
- `ship` 生成的 PR 正文改用仓库 PR 模板结构
- 安全门禁补充 Windows 磁盘与影子副本操作（`diskpart`、`cipher /w`、`vssadmin delete shadows`、`Format-Volume` 等），以及 Git 历史重写（`update-ref -d`、`filter-branch`、`push --mirror`、`reflog expire`）的确认
- 新增 `LICENSE`（MIT）与 `package.json`（`engines.node >= 18`、`npm test`）
- 新增 PR 模板：统一变更类型、验证清单与影响面说明
- 修正 `ship` 在 Windows 上的仓库根目录判断：用 realpath 归一化 8.3 短路径与分隔符，避免 `git rev-parse --show-toplevel` 与 `--plugin-root` 字面不一致
- 修正 CI 与文档中的测试命令：改用 `node --test`，避免 Node 22 把目录参数当作模块路径导致 `MODULE_NOT_FOUND`
- 新增 GitHub Actions：Node 20/22 跨平台运行测试，并执行 init → gen → doctor 冒烟
- 新增 `/devflow:ship`：回灌后创建分支、提交、推送并生成 PR，支持 `gh`、GitHub API（`GITHUB_TOKEN`）与 compare 链接三种方式
- 阶段目录支持 `references/` 与 `templates/` 资源：随 init 复制、写入投影与生成账本、doctor 校验、回灌递归处理
- 子项目测试命令从工作区根生成，支持 `packageManager` 与 lockfile 探测
- hooks 自身异常时放行；扩展危险命令规则（强推保护分支、Windows 盘符根删除等）
- 生成器清理账本中已移除阶段的过期投影
- 修正文档中的安装方式与 hooks 作用域说明
- 文档补充 init 探测边界：含 `.git`/构建文件的目录会停止下钻，深层子项目（如容器仓库内的模块）需手动修正 `hub.yaml`；根无构建文件时 `defaults.testCommand` 回退为 `npm test`

## 1.0.0

- 初始版本：六阶段工作流（req / plan / implement / test / review / debug）
- 项目级 `.claude/hub/` 单一真源与薄壳投影
- 多根工作区支持（含 `services/api` 两层探测），统一从工作区根启动
- 关键项 hooks：系统级破坏命令阻止，丢数据风险操作要求确认，未测试提醒
- 五个通用技能、三个子代理、评审/测试/排障参考清单
- 手动回灌与版本兼容检查
- 初始化、生成、体检、回灌、测试标记五个脚本
