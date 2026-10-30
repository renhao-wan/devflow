# Changelog

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
