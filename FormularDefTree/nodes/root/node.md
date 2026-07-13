---
id: root
parent: null
status: active
version: 0.1.0
---

# kimi-code FormularDef Root

## Motivation

kimi-code monorepo 的语义事实树。代码是事实来源;本树只记录靠读代码难以
快速重建、且对变更决策有约束力的语义模型(状态机、不变量、Gap)。

## Scope

- 只覆盖当前任务相关的子树,不全量形式化整个项目。
- 每个节点是一个自包含的局部 formular(Design/Implementation 对 + Refinement Map)。

## Invariants

```text
I1 Evidence first:实现 formular 的每条结论必须有代码证据或显式标记 unknown。
I2 Design 与 Implementation 分离;Gap(D, I) 允许存在且必须显式。
I3 快照规则:实现 formular 只对 tree.yml 记录的快照有效;代码实质变更后
   更新快照并把受影响节点标记 needs_catchup。
I4 验证与风险成比例:能用场景/评审说清的,不上形式化工具。
```

## Children

- `spine_compaction`:agent-core-v2 中 spine(实验任务树)与 full compaction
  (上下文压缩)的交互语义与冲突面。
- `undo_spine_compaction`:undo × spine × compaction 三域共享的口径同一性
  (caliber identity)不变量及其全部已确认违规——"频繁 compact" 诊断与
  undo×spine 复查的权威节点。
