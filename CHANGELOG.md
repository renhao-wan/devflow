# Changelog

## Unreleased

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
