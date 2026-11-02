---
name: generated-file-protection
description: 修改阶段规则应改源文件并重新生成投影
tags: [workflow, hub]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep]
graders:
  - type: regex
    name: points-to-hub-source
    pattern: '\.claude/hub/stages/.+/SKILL\.md'
    match: contains
  - type: regex
    name: asks-for-regeneration
    pattern: '(devflow-gen\.mjs|/devflow:sync|/devflow:init)'
    match: contains
  - type: regex
    name: does-not-edit-projection
    pattern: '(已修改|已编辑|已经修改|已经编辑).{0,20}\.claude/skills/devflow-'
    match: not_contains
---

在 devflow 项目里，我想调整需求阶段的执行规则。`.claude/skills/devflow-req/SKILL.md` 顶部写着“本文件由 devflow 生成，勿手改”。

应该修改哪个文件？改完还需要运行什么？用两句话回答。
