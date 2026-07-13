---
id: undo_spine_compaction
parent: root
status: active
version: 0.2.1
---

# undo × spine × compaction Caliber-Identity FormularDef Node

## Motivation

"频繁 compact" 诊断(2026-07-13)揭示:undo、spine、compaction 三个域共享一个
隐含不变量——**存储历史与模型所见同一**(caliber identity)。v1 式 compaction
物理替换历史,不变量自然成立;spine 把存储改为 append-only + 投影折叠,
不变量被打破,而多个旧路径仍按它工作。本节点把 trio 的共享状态、不变量、
以及全部已确认违规形式化,作为后续修复的验收基准。

## Snapshot Scope

```text
repo: project
paths:
  - packages/agent-core-v2/src/agent/contextMemory/(contextMemoryService, contextOps).ts
  - packages/agent-core-v2/src/agent/contextSize/(contextSizeService, contextSizeOps).ts
  - packages/agent-core-v2/src/agent/spine/(spineService, spineFold, spineOps).ts
  - packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts
  - packages/agent-core-v2/test/agent/fullCompaction/repro-frequent-compaction.test.ts
status: current
```

## Parent Contract

继承 root I1–I4。本节点是 trio 关系的权威节点;`spine_compaction` 节点
保留路由设计的细节,其 Gap 与本节点交叉引用。

## Quint-Style Kernel

Design kernel(候选,从诊断结论反推,未经用户批准):

```quint-pseudo
module undo_spine_compaction {
  type Msg = { role: Role, origin: Origin }
  type Node = { id: str, openedAt: int, closedAt: int | none, memory: str | none }
  type Gauge = { length: int, tokens: int, kind: {Measured, Estimate} }

  // 三域共享的可观察状态
  type State = {
    history: Seq[Msg],        // contextMemory 拥有(存储)
    tree: { nodes: Node[], epochStartAt: int, epochMemoryAt: int | none },  // spine 拥有
    gauge: Gauge,             // contextSize 拥有(live-only)
    lastObserved: int,        // spine 内存态(findEvidence 起点)
    pending: Transition | none
  }

  type Event =
    | Append(Msg) | Undo(cut: int) | Clear
    | RootCompact(epochStartAt: int) | ApplyCompaction(newHistory: Seq[Msg])
    | StepEnd(toolCallId) | Restore

  // 投影:模型所见 = fold(history, tree);gauge 触发 = gauge.tokens + est(尾部)
  pure def view(s: State): Seq[Msg] = foldSpine(s.history, s.tree)
  pure def triggerSize(s: State): int = s.gauge.tokens + est(s.history[s.gauge.length:])

  pure def inv(s: State): bool =
    // INV-IDX 下标锚定:树内所有下标落在历史范围内
    and {
      forall n in s.tree.nodes: n.openedAt < len(s.history),
      forall n in s.tree.nodes: n.closedAt != none => n.closedAt < len(s.history),
      s.tree.epochStartAt <= len(s.history),
      s.lastObserved <= len(s.history)
    }
    // INV-CAL 口径同一:gauge 的估算值 ≈ 下一次请求的真实成本(投影口径)
    //   est(raw history) ≈ est(view(s)) —— spine 下 raw ≫ view,估算必须走投影
    // INV-VIEW 投影诚实:view 既不复活已截断内容,也不隐藏存活内容
    //   forall e in {Undo, Clear}: view(s') 只含 s'.history 中的消息(除合成 memory/status)
    // INV-SYNC 提交同步:已接受回执 <=> 已提交 op(树 == 模型认知)

  // 反例形状(全部已复现,见 Validation):
  //   破 INV-IDX/INV-VIEW: Undo 切进 closed span -> fold 吐出陈旧 memory 并
  //     跳过越界 closedAt -> 其后全部新消息被吞噬(repro F)
  //   破 INV-IDX(lastObserved): Undo 后下一个 spine 转移 findEvidence 越界
  //     -> null -> 转移丢失(repro E)
  //   破 INV-IDX(epochStartAt): Clear 后 epochStartAt 悬空 -> fold 丢弃全部
  //     重建历史(repro G)
  //   破 INV-CAL: Undo 重定基 = est(原始存活历史) >> est(投影) -> 虚假压缩
  //     (repro D);Resume 后 gauge={0,0} 同理(静态)
}
```

## Design Formular

```text
D(候选,未经批准):
  D1 任何截断/清空历史的事件(Undo/Clear/ApplyCompaction)必须同时:
     (a) 把树内越界下标钳入 [0, len(history')) 或重置受影响节点;
     (b) 把 gauge 重定基为 投影口径 估算;
     (c) 把 lastObserved 钳到 len(history')。
  D2 gauge 的所有估算路径(undo 重定基、resume 回退、compaction 落地)
     统一使用 est(project(history))。
  D3 spine 模式下 compaction 的 summary 输入为当前历元
     (旧历元已由 summary + 归档覆盖);溢出启发式同用投影口径。
  D4 历元边界是 undo 的硬边界(现状,有意的行为对齐)。
```

## Implementation Formular

```text
I(快照 4ade2ee9b,全部 verified):
  Undo:  contextMemoryService.undo (:99-111)
    - 边界: computeUndoCut 遇 compaction_summary 停止 (contextOps.ts:301-320)
    - 级联: sizeOpsForCut (:160-170) —— 仅当 cutIndex < gauge.length 时,
      gauge := est(原始存活前缀)  ← 违反 D1b/D2(spine 下 raw ≫ view)
    - spine 侧: 无任何订阅;lastObserved 不动  ← 违反 D1c;树下标悬空 ← 违反 D1a
  Clear: promptService.clear -> context.clear (:89-97)
    - gauge := {0,0}(诚实);树完全不动  ← 违反 D1a(repro G)
  RootCompact: applyRootCompaction (fullCompactionService.ts:779-832)
    - append-only + gauge := est(summary)(投影口径,正确);树历元推进(正确)
  Summary 输入: originalHistory = 全部存储历史 (:609)  ← 违反 D3
    (实测: 460k / 773k / 1.04M token;repro A: 需 3 次收缩)
  413 启发式: estimateCurrentRequestTokens = 原始历史 (:237-239)  ← 违反 D3
    (repro C: 一个 turn 内 3 次徒劳压缩后硬失败)
  Resume: gauge live-only,重放后 {0,0} (contextSizeOps.ts:30-32),
    get() 回退 est(全部原始历史) (contextSizeService.ts:85)  ← 违反 D2(静态)
  折叠: foldSpine span 不钳制 (spineFold.ts:95-103)  ← 违反 INV-VIEW(repro F)
  提交: findEvidence(from=lastObserved) 不钳制 (spineService.ts:368-374,
    544-565)  ← 违反 INV-SYNC(repro E,每次 undo 丢一个转移)
  分类:
    - RootCompact 路由/历元推进/阻塞时序: intended(test/spine/compaction.test.ts)
    - undo 边界停在 summary: intended(与非 spine 对齐)
    - 上述各违反项: bug(未感知 spine 的存储/视图分离)
    - flag 运行中翻转、异步压缩交错: unknown(非默认路径,未复现)
```

## Refinement Map

```text
alpha_state: (ContextModel, SpineModel, ContextSizeModel, 内存 pending/lastObserved)
           -> (history, tree, gauge, lastObserved, pending)
义务: I 在 {Undo, Clear, Resume, 413} 事件上不 refine D(D1a-c/D2/D3 全部有反例);
      I 在 {RootCompact, 阻塞式自动压缩} 上 refine D(既有测试)。
剩余证明义务: D1a 的"钳制 vs 重置节点"语义需用户拍板(见 Gap 批次 3)。
```

## Gap(D, I) / Known Non-Refinements / Debt

```text
按严重度排序(复现 = test/agent/fullCompaction/repro-frequent-compaction.test.ts,
该 scratch 已删除,场景转为正式回归测试):

P1 [FIXED 2026-07-13] undo 切进 closed span -> 陈旧 memory 吞噬其后全部新消息
   (含用户最新 prompt),模型盲答。spineFold.ts:95-103 不钳制 closedAt。
   修复:spine.truncate_repair op(spineOps.ts)在 undo 截断时持久化修复
   (跨切点 span 钳到 cut-1、全截断 span 作废、open span 重启于切点);
   spineService 订阅 context.spliced 触发。回归:test/spine/spine.test.ts
   "keeps post-undo messages out of a truncated closed span" + 两个 reducer
   测试。
P2 [FIXED 2026-07-13] undo 后 lastObserved 越界 -> 下一个 spine 转移被 drop
   (每次 undo 丢一个,树与模型认知分叉;误报 unexpected error)。
   修复:截断时游标重置为 min(lastObservedIndex, cut)(spineService splice
   订阅)+ commitPending 钳制兜底。回归:"commits a spine transition after
   an undo shrank the history"。
P3 [FIXED 2026-07-13] /clear(尤其历元边界后)-> epochStartAt 悬空 ->
   fold 丢弃全部重建历史,模型只剩 status 行。
   修复:truncate_repair 同时钳 epochStartAt/epochMemoryAt(clear = cut=0
   的同一修复路径,旧历元保留在树中)。回归:"keeps the rebuilt history
   visible after /clear with a dangling epoch boundary"。
P4 [FIXED 2026-07-13] undo 重定基用原始估算 -> gauge 毒化 -> 下一 turn 虚假
   阻塞压缩。"频繁 compact" 主根因;真实会话(mre987c4)3/3 次 auto 压缩
   全部 undo 后触发,真实请求仅 29-46k。
   修复:sizeOpsForCut 改投影口径(contextMemoryService 注入
   contextProjector,try/catch 回退原始估算)。回归:
   fullCompaction.test.ts "does not auto-compact after an undo when the
   folded view is small"。
P5 [FIXED 2026-07-13] summary 输入 = 全部原始历史(实测 77-104 万 token/次,
   5 次合计 335 万);窗口不足时收缩阶梯后仍可能失败,且阈值路径无熔断。
   修复:epochScopedHistory —— 仅当前历元 + 前历元 summary 链入
   (fullCompactionService)。回归:test/spine/compaction.test.ts
   "summarizes only the current epoch and chains the previous epoch summary"。
P6 [FIXED 2026-07-13] 413 启发式按原始估算 -> 3 次徒劳压缩后 CONTEXT_OVERFLOW。
   修复:estimateCurrentRequestTokens 改投影口径。回归:
   "does not treat a provider 413 as context overflow when the projected
   view is small"。
P7 [FIXED 2026-07-13] 非 spine: 压缩后 floor 仍 >= 阈值时每个 turn 重压。
   修复:compactionFutile 抑制器(tokensAfter 仍超阈值则暂停 auto 压缩并
   warn,历史替换/模型降档时解除)+ floor 跨 turn 保留(模型降档/历史
   替换时重置)。回归:"pauses auto compaction when the compacted shape
   still exceeds the threshold"。
P8 [FIXED 2026-07-13] resume 后 gauge 回退 est(全部原始历史)。
   修复:contextSizeService.get() 从未测量时全量估算改投影口径
   (estimateProjected,带重入防护——fold 的 buildStatus 会读回 gauge)。
   注:该重入循环在实现时被测试捕获(空上下文无限递归),防护已入代码。
P9 [open, 静态] 异步压缩模式(compactionTriggerRatio < blockRatio)下
   pending × root_compact 交错:关错节点或 guard 静默 no-op 且审计不可见。
   非默认配置。详见 spine_compaction 节点 G-A。
P10 [debt→缓解] spine 模式下存储历史只增不减:compaction 成本随会话年龄
   增长——P5 修复后 summary 输入改为当前历元,成本有界;undo 够不着旧
   历元(与"历史可追溯"卖点的张力)留作设计讨论(批次 3)。
P11 [open] flag 运行中翻转:pending 不清、lastObserved 不推进,未定义。
```

## Validation

```text
Validation Choice: scenarios(复现套件)+ review;不上可执行 Quint。
Reason: 全部不变量都有具体反例轨迹,修复为局部钳制/口径替换;缺机制不缺证明。
  升级条件不变:undo 语义重做(批次 3)或异步压缩成为默认时,把 kernel
  落成 .qnt 做交错检查(需用户明确要求)。
Result:
  - 复现套件(A-G)已于修复后转为正式回归测试并全部转绿(2026-07-13):
    A→test/spine/compaction.test.ts;B/C/D→test/agent/fullCompaction/
    fullCompaction.test.ts;E/F/G→test/spine/spine.test.ts;scratch 文件
    已删除。
  - 真实会话取证: wd_kimi-code-bench-analysis/mre987c4(聚合统计,
    未读消息内容): 5 begins / 4 completes / 1 cancel;3 次 auto 全部 undo 后;
    summary 请求 460k/30k(异常,见下)/1.04M/773k。
  - 未解异常: 07-10 19:46 的 summary 请求仅计费 30k(同时段同规模历史
    计费 460k),所有 commit 均为全量输入,疑为当天 WIP build 行为;
    不影响主结论。
  - 修复副作用:既存 7 个快照(loop/plan/tool/config)更新——P8 顺带
    修正了 rawSize 在未测量窗口对 (raw−projected) 的双重计数(旧值
    偏高);新快照值 = 真实 raw 估算。
```

## Code Mapping

```text
undo:      contextMemory/contextMemoryService.ts:89-170, contextOps.ts:301-380
gauge:     contextSize/contextSizeService.ts:70-115, contextSizeOps.ts:60-108
fold:      spine/spineFold.ts:66-118; 提交: spine/spineService.ts:363-470,544-565
compact:   fullCompaction/fullCompactionService.ts:237-275,432-509,604-832
repro:     test/agent/fullCompaction/repro-frequent-compaction.test.ts (A-G)
既有测试:  test/spine/(compaction, fold, archive, spine).test.ts
```

## Evolution Log

```text
2026-07-13 节点创建(频繁 compact 诊断 + undo×spine 复查):
  形式化 trio 共享不变量 INV-IDX/CAL/VIEW/SYNC;P1-P11 全部记录,
  其中 P1-P7 有复现(7 红),P8/P9/P11 静态。快照 4ade2ee9b (spine-v2)。
2026-07-13 (v0.2.0) P1-P8 全部修复并转正式回归测试(全量 3285 测试绿):
  truncate_repair op + splice 订阅(P1/P2/P3)、gauge 投影口径(P4/P8,
  附带 rawSize 双重计数修正与 7 个快照更新)、历元范围 summary 输入
  (P5)、413 投影口径(P6)、compactionFutile + floor 跨 turn(P7)。
  修复期新增发现并堵上 estimateProjected 重入循环(fold buildStatus
  读回 gauge)。P9/P11 保持 open(非默认路径)。scratch 复现文件已删除。
2026-07-13 (v0.2.1) deep review 跟进(外部评审四条):
  F1(声称 undo 越过历元边界致盲)经核验不可达——computeUndoCut 遇
  compaction_summary 即停且不足 count 整体拒绝(contextOps.ts:301-320),
  切点永远 ≥ epochStartAt;仍按建议防御化:anchor 被截则 epochStartAt
  回退 0(无损保守),不再压到 cut。
  F2(升档不清 futile/floor)修复:任何窗口变化即重校准。
  F3(投影估算三处拷贝)收敛为 IAgentContextProjectorService.
  estimateProjectedTokens;重入守卫留在 contextSize 本地包裹。
  F4(splice 隐含尾部截断契约)加不变量注释 + 非等长跳过防御。
```
