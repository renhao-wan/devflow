# devflow 设计

日期：2026-10-27

## 目标

参考企业级 AI 规范工具的架构，做一个适合 Claude Code 的个人工程工作流插件。保留三个精髓：单一真源、薄壳入口、可回灌；去掉安装器和多端适配。

## 已确认的决策

| 决策点 | 结论 |
| --- | --- |
| 形态 | Claude Code 原生 plugin |
| 范围 | 通用工程核心，语言无关 |
| 受众 | 个人为主，结构上留分发余地 |
| 架构 | 薄壳 + 单一真源 |
| 工作区 | 多根，统一从根启动 |
| hub 位置 | `<根>/.claude/hub/` |
| hooks | 关键项阻止：危险命令拦，未测试提醒 |
| 回灌 | 手动触发 |
| 命令归属 | 插件统一提供 `/devflow:*` |
| 初始化 | 内置模板 + 自动探测 |

## 分层

```
插件（出厂默认）
  commands/ + skills/ + agents/ + hooks/ + templates/
        │ init 时复制模板
        ▼
项目 .claude/hub/（项目真源）
  hub.yaml + stages/<stage>/{SKILL.md, references/, templates/} + _shared/
        │ 生成器投影
        ▼
项目 .claude/skills/devflow-*（薄壳）
```

## 六阶段与门禁

| 阶段 | 产出 | 硬门禁 |
| --- | --- | --- |
| req | req.md | 验收标准非空，未知项列明 |
| plan | plan.md | 每个改动点有验证方式 |
| implement | 代码 | 小步，可编译，优先 TDD |
| test | 测试证据 | 通过要有命令与输出 |
| review | 评审结论 | 高危未修不得通过 |
| debug | 根因与回归 | 无复现不下结论 |

## hooks

`guard-dangerous` 对所有项目生效；状态记录、结束提醒与会话注入只对含 `.claude/hub/hub.yaml` 的项目生效。

| 事件 | 行为 |
| --- | --- |
| PreToolUse(Bash) | 危险命令阻止 |
| PostToolUse(Edit/Write) | 记录改动文件 |
| Stop | 有改动但未测试则提醒 |
| SessionStart | 注入当前子项目和测试命令 |

## 回灌

`hub-upstream` 递归对比项目 stage 目录与插件模板，分类为 project-local / reusable；只把 reusable 写入插件模板，手动确认后 bump 版本。

## 里程碑

- [x] 插件骨架、命令、技能、agent
- [x] hub 脚本：init / gen / doctor / upstream / mark-test
- [x] hooks 脚本
- [x] 测试与示例工作区验证（32 项测试通过）
- [x] 文档与版本 1.0.0
