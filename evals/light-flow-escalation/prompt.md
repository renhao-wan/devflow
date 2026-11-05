---
name: light-flow-escalation
description: 轻量修复改到认证等高风险区域时应升级完整流程
tags: [workflow, escalation, risk]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep]
graders:
  - type: regex
    name: escalates
    pattern: '(升级|完整流程|升级判断)'
    flags: i
    match: contains
  - type: regex
    name: names-risk
    pattern: '(认证|权限|安全|auth)'
    flags: i
    match: contains
  - type: regex
    name: does-not-stay-light
    pattern: '(?<!不|未|没|能|应|不是|并非|不能|不应|无法)(建议|应该|应|可以|直接|还是|不妨)(继续|走).{0,4}轻量|(结论|判断)[：:][^。\n]{0,20}(?<!不是|并非|不能|不应|无法)(不需要|无需|不必)升级'
    flags: i
    match: not_contains
---

用户报了一个小 bug：登录态偶尔失效。你准备用 devflow 的轻量修复通道直接改 `src/auth/session.js`。

按照 devflow 的规则，这个修复应该继续走轻量流程，还是先升级？只回答判断与理由，不要开始改代码。
