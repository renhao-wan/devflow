/**
 * 统一 CLI 的子命令表：`bin/devflow` 用它分发，doctor 用它校验插件仓库里的脚本是否齐全。
 * 值依次是脚本文件名与帮助描述，避免命令列表散落在多处。
 */
export const COMMANDS = {
  init: ['hub-init.mjs', '初始化项目工作区（.claude/hub、loader、投影与可选规则草稿）'],
  gen: ['gen-claude-skills.mjs', '从 .claude/hub 生成阶段投影'],
  doctor: ['hub-doctor.mjs', '体检配置、版本、投影与 hooks'],
  status: ['hub-status.mjs', '只读查看进度、产物缺口与下一步命令'],
  onboard: ['hub-onboard.mjs', '扫描项目并生成/更新 .claude/hub/project-overview.md'],
  statusline: ['statusline.mjs', '输出单行进度，供 Claude Code statusLine 配置使用'],
  route: ['hub-route.mjs', '判断当前阶段是否应先用其他工具（--detect 自动检测）'],
  sync: ['hub-sync.mjs', '按团队/个人/上游优先级同步阶段、共享与技术栈模板到项目（三方合并，--dry-run 预览）'],
  upstream: ['hub-upstream.mjs', '预览或回灌阶段/共享规则/技术栈到个人库、团队库或上游插件（默认预览）'],
  ship: ['hub-ship.mjs', '回灌、提交并创建或更新 PR'],
  test: ['mark-test.mjs', '记录一次测试结果（--gaps 查看测试缺口，--changed 查看受影响测试）'],
  triage: ['review-triage.mjs', '判定审查触发、风险方向与子代理上限（--since 增量复审）'],
  check: ['stage-check.mjs', '校验 req / debug 产物结构是否完整'],
  trace: ['trace.mjs', '查看验收项到 plan / test / review 的追踪矩阵（--check 缺失时退出 1）'],
  stack: ['hub-stack.mjs', '按需安装、更新、恢复与删除技术栈包（--from 本地目录或 --repo 远程仓库）'],
};
