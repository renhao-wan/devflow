# devflow 文档

根目录 [README](../README.md) 负责安装与首个流程；本页按使用场景整理其余文档。

## 建议阅读顺序

1. [README](../README.md)：定位、安装、快速开始、命令与阶段概览。
2. [usage.md](usage.md)：阶段细节、轻量流程、方案调研、`hub.yaml`、阶段资源、单一真源、多根工作区与 statusline。
3. [hooks.md](hooks.md)：hooks 作用域、生成物写保护、危险命令的 deny/ask 清单与拦截边界。
4. [tool-routing.md](tool-routing.md)：同类工具登记、检测、路由决策与安全边界。
5. [native-capabilities.md](native-capabilities.md)：Claude Code 原生能力接入、版本要求与降级。
6. [maintenance.md](maintenance.md)：回灌、插件升级、启用状态、ship/PR 与故障排查。
7. [development.md](development.md)：脚本参考、目录结构、测试、CI、行为评测与版本兼容。

## 使用与配置

| 文档 | 内容 |
| --- | --- |
| [usage.md](usage.md) | 六个阶段与轻量流程、方案调研、`hub.yaml`、阶段资源、投影生成、多根工作区、statusline |
| [hooks.md](hooks.md) | 安全门禁、hooks 事件表、生成物写保护、deny/ask 清单、fail-open |
| [tool-routing.md](tool-routing.md) | `ecosystem.yaml`、工具检测、路由决策、命令参考 |
| [native-capabilities.md](native-capabilities.md) | 子代理、`AskUserQuestion`、`/goal`、plan mode、hooks、statusline 的接入与降级 |

## 维护与开发

| 文档 | 内容 |
| --- | --- |
| [maintenance.md](maintenance.md) | 回灌、升级与同步、启用状态与重启、提交与 PR、故障排查 |
| [development.md](development.md) | 脚本参考、插件与项目目录结构、开发测试、CI、evals、版本约定 |

## 设计与评估

| 文档 | 内容 |
| --- | --- |
| [design.md](design.md) | 目标、分层、职责边界、阶段门禁、hooks、回灌、路由与安全边界 |
| [comparison.md](comparison.md) | 与 BMAD、Spec Kit、OpenSpec 等同类方案的对比与定位 |
| [value-and-limits.md](value-and-limits.md) | 价值来源、适用人群、当前限制与验证方法 |

## 安全

- [SECURITY.md](../SECURITY.md)：漏洞报告方式与安全边界。
- [hooks.md](hooks.md)：命令拦截规则与已知绕过风险。

版本变更见根目录 [CHANGELOG.md](../CHANGELOG.md)。
