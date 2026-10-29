# Changelog

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
