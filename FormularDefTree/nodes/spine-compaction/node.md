---
id: spine_compaction
parent: root
status: active
version: 0.1.2
---

# Spine × Full Compaction Interaction FormularDef Node

## Motivation

`spine`(实验 flag `KIMI_CODE_SPINE`,默认关)让模型用 `spine_open/close/next`
维护一棵任务树,并按绝对消息下标记账;`full compaction` 在上下文超预算时
压缩历史。两者都作用于同一份 context 历史,需要判定共存时语义是否冲突。
本节点回答用户问题:"spine 和 compact 是不是有冲突,是否需要形式化验证"。

## Snapshot Scope

```text
repo: project
paths:
  - packages/agent-core-v2/src/agent/spine/**
  - packages/agent-core-v2/src/agent/fullCompaction/**
  - packages/agent-core-v2/src/agent/contextMemory/**
  - packages/agent-core-v2/src/agent/contextProjector/**
  - packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts
  - packages/agent-core-v2/src/wire/wireServiceImpl.ts
  - packages/agent-core-v2/test/spine/**
status: current
```

## Parent Contract

继承 root I1–I4。本节点只记录 spine × compaction 交互面,不重复定义两个
子系统各自的完整语义。

## Quint-Style Kernel

Design kernel(从观察到的协同设计意图反推的候选模型,未经用户批准):

```quint-pseudo
module spine_compaction {
  type Msg = { role: Role, origin: Origin }
  type NodeId = str
  type Node = { id: NodeId, openedAt: int, closedAt: int | none,
                memory: str | none, archivePath: str | none }
  type SpineTree = { nodes: NodeId -> Node, openStack: Seq[NodeId],
                     rootEpoch: int, epochStartAt: int, epochMemoryAt: int | none }
  type Pending = { kind: {Open, Close, Next}, toolCallId: str, payload: str } | none
  type CompactionPhase = Idle | Running

  type State = {
    history: Seq[Msg],        // append-only 存储历史(wire ContextModel)
    tree: SpineTree,
    pending: Pending,
    compaction: CompactionPhase,
    spineEnabled: bool
  }

  type Event =
    | StepToolCall(SpineToolKind, payload)   // accept:登记 pending
    | StepEnd                                // commitPending:dispatch spine op
    | CompactionBegin | CompactionLand(summary)
    | Clear | Undo(n) | FlagFlip(bool)

  type Effect = ArchiveWrite(path, content) | WireRecord(op)
  type Obs = { projection: Seq[Msg], cursor: NodeId }

  // 投影:fold(history, tree) — 纯函数,不改存储
  pure def obs(s: State): Obs = {
    projection: foldSpine(s.history, s.tree),   // spineFold.ts:66-118
    cursor: topOf(s.tree)
  }

  // 候选不变量(其中 INV2/INV3/INV4 在实现中被违反,见 Gap)
  pure def inv(s: State): bool =
    // INV1 下标锚定:树内所有下标都落在历史范围内
    and {
      forall n in s.tree.nodes: n.openedAt < len(s.history),
      forall n in s.tree.nodes: n.closedAt != none => n.closedAt <= len(s.history),
      s.tree.epochStartAt <= len(s.history)
    }
    // INV2 语义锚定:close/next 作用于 accept 时的 cursor,而非 commit 时的 top
    // INV3 spine 开启 => 历史 append-only(任何事件不删除/替换 history 前缀)
    // INV4 历元互斥:pending != none 期间不发生 CompactionLand
    // INV5 口径一致性:gauge(context_size)估算的必须是投影口径
    //       (下一次请求的真实成本),不是存储口径。任何事件后:
    //       gauge(s') ≈ estimate(project(history')),而非 estimate(history')。
    //       (2026-07-13 确认:undo 重定基与 resume 回退违反此条,见 G-E/G-F)
}
```

Counterexample Shape(使不变量可证伪的最小轨迹):

```text
反例 A(破 INV4→INV2):config(compactionTriggerRatio < blockRatio) 下,
  afterStep 启动异步压缩 → step N+1 模型调 spine_close(accept) →
  压缩 worker 落地 root_compact(openStack 重置) → step 末 commit:
  close 落到新历元 startup 节点上,或 reducer guard 静默 no-op。
反例 B(破 INV1):spine 开启,树有 closed 节点 → /clear(history := []) →
  epochStartAt/节点下标全部悬空,fold 丢弃重建后的全部新消息。
反例 C(破 INV1):spine 开启 → undo 截断 history → 已关闭节点 span
  覆盖到无关新消息(下标碰撞)。
```

## Design Formular

```text
D : (history, tree, pending, compactionPhase) x Event -> State' x Effect | Error

candidate(未经用户批准,从实现意图反推):
  spineEnabled == true 时:
    D1 CompactionLand = append(summary) + epochBoundary(rootEpoch+1),
       绝不改写 history 前缀;
    D2 StepToolCall/StepEnd 与 CompactionLand 互斥(历元边界是原子的);
    D3 Clear/Undo 要么被禁止,要么重置 tree 到新历元;
    D4 投影收敛:obs(fold) 只依赖 (history, tree),与压缩次数无关。
  无用户批准的目标语义时,Design 维持 candidate;不要当作约束冻结。
```

## Implementation Formular

```text
I : 同上 State x Event -> State' x Effect | Error(快照见 tree.yml)

路由(verified):
  fullCompactionService.ts:721-729
    flags.enabled(SPINE_FLAG_ID) == true  => applyRootCompaction(:779-832)
      = context.append(summaryMsg)                      // :793
        + spine.archiveEpochRoot (副作用,失败只 warn)    // :798-813
        + dispatch spine.root_compact + context_size     // :814-822
    false => context.applyCompaction(...)                // 物理改写历史
  spineRootCompact guard: epoch == rootEpoch+1,否则 no-op  // spineOps.ts:195-209

转移协议(verified):
  spine_open/close/next 是 receipt-only 工具;accept 只登记 pending
  (spineService.ts:202-241),真正移动发生在 onDidFinishStep 的
  commitPending(:363-398):close/next 的节点 id 在 commit 时取
  topOf(state)(:429, :445),不是 accept 时的 cursor。
  commitClose 在读 state 与 dispatch 之间有 await archiveNode(:437)。
  reducer guard 失败返回同一引用(spineOps.ts:119-139),
  但 record 无条件写入 wire log(wireServiceImpl.ts:262-268),
  restore 审计按 record 计数(spineService.ts:284-302)=> guard 拒绝的
  op 与 receipt 数量对得上,审计不可见。

触发模式(verified):
  默认 config triggerRatio == blockRatio == 0.85(strategy.ts:18-28):
    自动压缩全部阻塞式(beforeStep block,fullCompactionService.ts:432-437),
    afterStep 异步路径关闭(checkAfterStep == false,strategy.ts:65-67),
    手动压缩要求 lane idle(:324-329)。
    => 压缩 worker 与 turn 步骤不并发,主路径安全,且有测试
       test/spine/compaction.test.ts(5 用例)覆盖。
  非默认 config(model.compactionTriggerRatio < 0.85):
    checkAfterStep == true,afterStep 非阻塞 begin(:480-482),
    下一步 tokens < blockRatio 时不 block => worker 与步骤并发。

行为分类:
  - 路由分叉 + append-only 历元边界:intended(有专门测试)
  - 默认配置下无并发:intended(配置注释明说 "disable async compaction")
  - 异步模式下 pending × root_compact 交错:bug(无互斥原语)→ G-A
  - /clear、undo 无 spine 协调:bug/unknown(代码内未见任何防御)→ G-B/G-C
  - flag 运行中翻转:unknown(pending 不清、lastObservedIndex 不推进)→ G-D
  - undo 重定基 / resume 回退按原始历史估算:bug(2026-07-13 确认)→ G-E/G-F
  - spine 模式下压缩输入为全量原始历史(:609):bug(生产观测 77-104 万)→ G-G
  - 413 启发式按原始历史估算(:269-274):bug(scenario C 红)→ G-H
  - 压缩后 floor 超阈值时每 turn 重压(小窗口):bug(scenario B 红)→ G-I
```

## Refinement Map

```text
alpha_state: (ContextModel 历史, SpineModel, 内存 pending, _compacting)
           -> (history, tree, pending, compactionPhase)
alpha_event: 工具调用/loop hook/RPC -> Event
beta_result: dispatch 的 op 与归档写 -> Effect

义务:I 在默认配置下 refines D(由路由分叉 + 阻塞式压缩保证,
     test/spine/compaction.test.ts 提供场景证据)。
     I 在非默认配置 / clear / undo / flag 翻转下不 refine D —— 见 Gap。
剩余证明义务:D2/D3 目前没有任何机制保证,只有时序巧合。
```

## Gap(D, I) / Known Non-Refinements / Debt

```text
2026-07-13 状态:G-B/G-C/G-E/G-F/G-G/G-H/G-I 已全部修复(机制与回归测试
见 undo_spine_compaction 节点 P1-P8)。G-A(异步交错)与 G-D(flag 翻转)
保持 open,非默认路径。以下保留原始记录。

G-A 异步压缩模式交错(bug,非默认配置可达)
  反例 A 轨迹。两种坏法:
  (a) root_compact 在 accept 与 commit 之间落地 => close 以 commit 时 top
      (新历元 startup 节点 '2.1') 为目标,关错节点,memory/archive 张冠李戴;
  (b) root_compact 落在 commitClose 内部 await archiveNode 窗口 =>
      reducer guard top != p.id 静默 no-op,record 照写,审计不可见,
      旧节点永远 open,归档文件成孤儿。
  证据:spineService.ts:427-441, spineOps.ts:119-139,
        wireServiceImpl.ts:262-268, fullCompactionService.ts:480-482,
        strategy.ts:65-67, 92-102。
  两侧均无互斥:spineService 不查 compaction.compacting,
  fullCompactionService 不查 spine.pending(全文 grep 无交叉检查)。

G-B /clear 无协调(bug)
  rpcService.ts:241 -> promptService.clear():168-172 -> context.clear
  清空 ContextModel;spine 侧无任何监听(spine 目录 grep 不到 clear)。
  epochStartAt/epochMemoryAt/节点下标悬空;clear 后 fold 把重建历史
  i < epochStartAt 全部丢弃(spineFold.ts:79-88),模型只剩 status 行。

G-C undo 无协调(已升级为确认 bug,详见 undo_spine_compaction 节点 P1/P2)
  context.undo 截断历史(contextOps.ts:373-380,遇 compaction_summary
  停止 :301-320);spine 不感知,产生两个已复现的违规:
  (a) undo 切进 closed span 后 fold 吐出陈旧 memory 并吞噬其后全部新消息
      (spineFold.ts:95-103 不钳制 closedAt;repro F);
  (b) lastObservedIndex 越界使下一个 spine 转移被 findEvidence 丢弃
      (spineService.ts:368-374, 544-565;repro E)。
  另:undo 重定基毒化 gauge 导致虚假压缩(repro D,"频繁 compact" 主根因)。

G-D flag 运行中翻转(unknown)
  enabled 实时求值(spineService.ts:198-200),工具注册只在构造时评估;
  关闭时 commitPending 直接 return,不清 pending、不推进
  lastObservedIndex(:363-366);重开后旧 pending 可能对晚得多的
  evidence 提交。

次要:
  - strategy.ts computeCompactCount/reduceCompactOnOverflow 在 live 路径
    无调用方(死代码,易误读)。debt。

G-E undo 重定基口径失配(bug,2026-07-13 确认,生产证据)
  sizeOpsForCut 在 undo 截断已测前缀时,把 gauge 重定基为
  estimateTokensForMessages(存活的原始历史)
  (contextMemoryService.ts:160-170)。spine 模式下存储历史 append-only,
  原始估算(~30-80 万)与模型所见的折叠投影(~3-6 万)差一个数量级,
  gauge 被毒化到超阈值 → 下一 turn beforeStep 必然虚假压缩。
  生产证据(会话 mre987c4):3 次 auto compact 全部紧跟 context.undo,
  历元间隔最小 3 条消息;触发前真实请求仅 29-46k。
  复现:test/agent/fullCompaction/repro-frequent-compaction.test.ts
  scenario D(红)。注:此 bug 在 4d23a80e1(07-08 前)引入时是对的
  —— 当时存储==所见;7204e3408(07-08 spine)打破不变量后未回头改。

G-F resume 回退口径失配(bug,代码确认,生产未直接观测)
  context_size.measured 是 persist:false 的 live-only op
  (contextSizeOps.ts:77-78);resume 后 Model 从 {0,0,[]} 起步,
  get() 回退到全量原始历史估算(contextSizeService.get :70-87)
  → 恢复长 spine 会话后第一个 turn 虚假压缩。与 G-E 同一根因。

G-G summary 输入全量原始历史(debt→confirmed,生产证据)
  compactionRound 输入 = 自会话开始的全部原始历史
  (fullCompactionService.ts:609)。生产观测:单次 summary 请求
  460k / 773k / 1,036,704 token(会话 mre987c4,07-13 当前 build)。
  窗口更小时走收缩阶梯(:662-678)甚至失败,且阈值路径失败无熔断
  (maxCompactionPerTurn=Infinity)→ 每 turn 重试注定失败的压缩。
  复现:scenario A(红,summaryAttempts=4,健康值 1)。

G-H 413 启发式口径失配(accidental→confirmed)
  estimateCurrentRequestTokens 按原始历史估算(:237-239),
  spine 模式下永久超 50% 窗口 → 任何 413 触发 overflow 恢复,
  root compact 不减少原始估算 → 重试仍 413 → 连压 3 次后硬失败。
  复现:scenario C(红,一个 turn 内 compaction.started=3)。

G-I 压缩后 floor 仍超阈值时每 turn 重压(bug,小窗口可达)
  handoff 形状保留真实用户消息(预算 20k,compactionHandoff.ts),
  有效窗口 < ~24k 时 floor 永远 ≥ 85%;lastCompactedTokenCount
  每 turn 清零(fullCompactionService.ts:392-396)→ 每 turn 重压。
  spine 无关。复现:scenario B(红,3 turn 3 次 begin)。

未解异常(诚实记录):
  会话 mre987c4 在 07-10 19:46 的第二次 compact,summary 请求仅计费
  30k(当时历史 1160 条、13 分钟前同内容计费 460k)。07-08 至今所有
  commit 的 compactionRound 均为全量输入,无法解释;疑为当日 WIP
  build 的中间态行为。不影响主结论(07-13 数据与当前源码吻合)。
```

## Validation

```text
Validation Choice: review + scenarios(针对性回归测试),不上可执行 Quint。

Reason(2026-07-13 更新,覆盖两类失效):
  1. 交错类(G-A..G-D):反例轨迹已构造,修复是局部机制(门控/订阅),
     不是协议级重新设计。
  2. 口径失配类(G-E..G-I,本日确认):bug 类别是"估算用了错误的抽象层"
     (存储口径 vs 投影口径),属静态不变量(INV5)违反,不是时态性质。
     反例小而确定,scenario 测试直接钉死;Quint 模型在此只会编码修复
     本身,而非发现新失效模式。该类的真正成因是"假设漂移"(07-08 前
     存储==所见成立,spine 落地后未回改)——防漂移靠显式不变量 +
     回归测试,不靠模型检查。
  成本面:忠实建模 fold + gauge 级联 + 触发条件的 .qnt 模型维护成本高,
  仓库无现成 Quint 基础设施,边际收益低。
  充分且成比例的验证组合:
    - scenario/harness 回归:repro A/C/D 修复后转正式测试
      (test/agent/fullCompaction/repro-frequent-compaction.test.ts);
    - property test(建议):随机历史 × 随机折叠结构 × 随机事件序列
      (append/close/undo/compact)下,断言 gauge 与投影估算的一致性
      (INV5 的可执行形式);
    - kernel 显式不变量(INV5)作为评审与后续 feature 的检查项。
  触发升级条件(不变):若异步压缩成为默认(G-A 交错面打开)、或 fold
  代数复杂化(嵌套/多 fold 交互),时态性质成为主角,再上 Quint 做
  交错模型检查(需用户明确要求)。

Result:
  - 默认配置主路径:pass(test/spine/compaction.test.ts 用例)。
  - P1-P8:全部修复并转正式回归测试(2026-07-13,见 Gap 各条);
    修复过程中发现并堵上一个新引入的重入循环(P8 的投影估算经 fold
    buildStatus 读回 gauge,空上下文无限递归)——estimatingProjected
    防护已入代码,说明该口径链路此前无任何测试覆盖。
  - 既有快照(loop/plan/tool/config 共 7 个)因 P8 修正 rawSize 在
    未测量窗口的双重计数而更新(新值更小、更准)。
  - P9/P11:open risk,非默认路径,未动。
```

## Code Mapping

```text
spine:        packages/agent-core-v2/src/agent/spine/(spineService, spineOps,
              spineFold, spineTree, spineArchive, flag, tools/*)
compaction:   packages/agent-core-v2/src/agent/fullCompaction/
              (fullCompactionService, strategy, compactionOps)
context:      packages/agent-core-v2/src/agent/contextMemory/(contextOps,
              contextMemoryService, compactionHandoff)
wire:         packages/agent-core-v2/src/wire/wireServiceImpl.ts:256-268
tests:        packages/agent-core-v2/test/spine/(compaction, fold, archive,
              spine).test.ts; test/agent/fullCompaction/*
```

## Evolution Log

```text
2026-07-13 节点创建(legacy_as_is 触发):记录 spine × compaction 交互的
  实现 formular、候选 design kernel、4 个 Gap;快照 4ade2ee9b (spine-v2)。
2026-07-13 "频繁 compact" 诊断:确认口径失配类根因(G-E..G-I),生产证据
  取自会话 mre987c4(undo 后虚假触发、summary 请求 77-104 万 token);
  新增 INV5(口径一致性);Validation 补充"为何不上形式化验证"的
  分类论证(交错类 vs 口径失配类)与 property test 建议。
2026-07-13 (本会话)undo×spine 复查:G-C 从"未定义"升级为确认 bug——
  两个独立违规均已复现(repro E: undo 后 spine 转移被 findEvidence
  丢弃;repro F: undo 切进 closed span 后 fold 吞噬全部新消息);
  /clear 后历元边界悬空复现(repro G)。trio 共享不变量与 P1-P11
  问题总表移入新节点 undo_spine_compaction。
2026-07-13 (v0.1.2) G-B/G-C/G-E/G-F/G-G/G-H/G-I 全部修复(详见
  undo_spine_compaction 节点 P1-P8 与回归测试);全量 3285 测试绿。
  G-A(异步交错)、G-D(flag 翻转)保持 open。
```
