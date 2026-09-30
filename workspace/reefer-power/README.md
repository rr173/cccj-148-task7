# 冷藏箱岸电接入、断电迁移、分时功率预算与负荷削峰模块

零依赖纯 Node.js（>=20）实现。提供浏览器操作台与 HTTP 接口，管理冷藏箱岸电插座预留、接电、
传感器采样（电流/温度/掉电）、回路跳闸冻结、按温控优先级的有序迁移与争用裁决；以及
**港口临时压低岸电时的分时功率预算、冷藏负荷削峰（先限功率、仍超限再短时断电）、
修订版本管理、计划失效重算与预算结束后按风险分批恢复**。
全部供电事实、预算、方案修订、削峰动作与恢复批次以**不可变流水 + 快照**持久化，
任何持久化边界崩溃后重启都归并唯一结果。

## 启动

```bash
node src/server.js                 # 默认 http://localhost:8080
PORT=9000 node src/server.js       # 自定义端口
REEFER_DATA_DIR=/data node src/server.js
node src/server.js --test-faults   # 启用崩溃注入接口（仅测试环境）
```

浏览器打开根路径即为操作台：配电拓扑/实时负载、未接电箱、异常采样、跳闸影响、迁移执行状态。

播种演示数据（先启动服务）：

```bash
node scripts/seed-demo.mjs
```

## 验收测试

```bash
npm test          # node --test test/
```

覆盖需求全部验收场景（接电/迁移 7 个 + 削峰 10 个）：
1. 正常预留并接电（一箱/一座位唯一、送电容量复核）
2. 容量 / 相制 / 箱型 / 可达性 / 无预留的拒绝
3. 采样重复回放、同键异值与命令标识复用冲突拒绝、超时钟偏差倒序样本隔离
4. 跳闸冻结新接电、剩余保温时限、按温控优先级的有序迁移与逐步确认
5. 两名电气员真实并行争抢同一备用插座（先提交者成功，后者收到冲突+可重算备选）
6. 迁移中途取消：释放未执行步骤目标、保留已完成步骤、可重新规划
7. 送电 / 迁移创建 / 换插座 repower 三个持久化边界 `process.exit` 崩溃后的恢复
8. 削峰：无需削峰、仅限功率达标、必须断电、过期读数回退铭牌、重叠预算合并、
   并发旧修订冲突与请求标识幂等、计划失效重算（只撤未执行）、结束后分批风险优先恢复、
   恢复途中遇更低上限暂停重算、发布/执行/恢复三个持久化边界崩溃恢复（无重复控制/重复记账/越限）

## HTTP 接口

所有写接口为 `POST` + JSON；建议带请求头 `X-Command-Id`（或 body.commandId）。

| 接口 | 说明 |
|---|---|
| `POST /api/topology` | 录入配电板、回路（相制/额定电流）、插座（额定/允许箱型/电缆可达区域） |
| `POST /api/reefers` | 导入冷藏箱：箱型、相制、电流/功率、区域、tempPriority、insulationHours、setpointC、cargoGrade、allowableRiseC |
| `POST /api/reservations` | 为所有未接电箱自动生成插座预留（温控优先级降序，同回路装箱保留备用回路） |
| `POST /api/connect` | 接电终端：`{reeferId, socketId}` + 命令标识，预留转供电；送电前容量/跳闸复核 |
| `POST /api/samples` | `{kind: current/temperature/powerLoss, sensorBootId, socketId|reeferId, measuredAt, value}` |
| `POST /api/circuits/trip` | `{circuitId}` 跳闸登记：冻结该回路新接电，返回受影响箱与剩余保温分钟 |
| `POST /api/circuits/reset` | 回路复位，FROZEN 箱就地恢复供电 |
| `POST /api/migrations` | 生成/提交迁移方案；`{commit:false}` 只出草案；`{recompute:true}` 按最新占用重算 |
| `POST /api/migrations/steps` | 逐步确认：`{planId, index, action: unplug|occupy|repower}`（必须按序号执行） |
| `POST /api/migrations/cancel` | 取消进行中方案：释放未执行步骤的目标租约，已完成步骤保留 |
| `POST /api/budgets` | 登记分时功率预算：`{startAt,endAt,shipLimitA,boardLimitsA:{板:A}}`（全船+配电板两级） |
| `POST /api/budgets/revoke` | 撤销一条预算登记（`{budgetId}`） |
| `POST /api/peak/plans` | 发布削峰修订；`{expectedRev}` 乐观并发；返回每步释放电流/持续时间/恢复最迟时刻 |
| `POST /api/peak/actions/execute` | 执行限功率/断电：`{actionIds:[]}`（只降载不反弹；逐步执行途中允许暂未达标） |
| `POST /api/peak/recompute` | 电流/温度变化致原计算失效：只撤销未执行动作并生成新修订，已生效事实保留 |
| `POST /api/peak/cancel` | 手动撤销方案：仅作废尚未执行动作，已生效限功率/断电不消失 |
| `POST /api/peak/restore` | 预算结束后分批恢复（`{maxBatchSize}`）；按可用余量与温度风险优先，途中遇更低上限暂停重算 |
| `GET /api/state` | 读模型：拓扑/实时负载/样本 + `peak`（预算曲线、新鲜度、削峰动作、温度风险、节省量、恢复进度） |

### 幂等语义

* 相同 `X-Command-Id` + 相同载荷摘要：返回首次答复（含首次失败，`replayed:true`），不产生任何副作用。
* 相同 `X-Command-Id` + **不同**载荷摘要：`409 IDEMPOTENCY_CONFLICT`，不改写当前接电状态。
* 样本接口按内容去重（同传感器启动代号/种类/对象/测量时刻）：完全重复回放首次答复；
  同键不同数值返回 `409 SAMPLE_CONFLICT`。

### 错误码

`BAD_REQUEST`（400）、`NOT_FOUND`（404）、`CONFLICT`（409），业务码在 `error.code`：
`NO_RESERVATION / SOCKET_MISMATCH / SOCKET_OCCUPIED / PHASE_MISMATCH / SOCKET_RATING_EXCEEDED /
BOX_TYPE_NOT_ALLOWED / AREA_UNREACHABLE / CIRCUIT_CAPACITY / CIRCUIT_TRIPPED /
TARGET_CONTENDED / TARGET_NOT_CLAIMED / STEP_ORDER / PLAN_CANCELLED /
IDEMPOTENCY_CONFLICT / SAMPLE_CONFLICT / OUT_OF_ORDER_CLOCK_SKEW /
NO_ACTIVE_BUDGET / REVISION_STALE / LOAD_REBOUND_ON_EXECUTE /
REEFER_NOT_POWERED / LIMIT_NOT_EFFECTIVE / NO_REVISION` 等。

## 核心规则

* **预留**：按温控优先级（数字大优先，再按剩余保温时间）排序，逐箱贪心；候选必须相制、
  额定电流、允许箱型、电缆可达区域全部匹配，且接入后回路承诺负载不越限。
  同回路装箱策略保留完全空闲的备用回路；并列按插座编号确定。
* **接电**：只有 RESERVE 租约可转 POWER；任一时刻一个插座最多一个活动租约、一个箱最多占用一个插座
  （迁移中间态允许 FROZEN/UNPLUGGED + CLAIM 成对存在）。跳闸回路拒绝新接电。
* **采样**：同一 `sensorBootId` 游标内测量时刻倒退超过 `REEFER_MAX_CLOCK_SKEW_MS`（默认 5000ms）
  的样本进入待审隔离区，不更新实时电流游标、不参与负载与保温时限计算。实时负载优先取
  5 分钟新鲜窗口内的电流采样，否则回退箱铭牌电流（`P/(√3·400·0.85)` 三相 / `P/(230·0.85)` 单相）。
* **跳闸**：该回路所有 POWER 租约立即 FROZEN，记录掉电时刻；保温剩余 = 保温时限 − (now − 掉电时刻)。
* **迁移**：按温控优先级、剩余保温时间生成有序步骤：
  `拔除(unplug) → 占用目标(occupy) → 送电(repower)`。方案创建即锁定首个目标（CLAIM），
  步骤必须按序号执行；未 repower 前原插座不释放、目标插座他人不可抢占。
  两人争用同一目标时，提交瞬间由服务端串行裁决：先提交者成功；后者 409 返回
  `conflicts`（当前占用人）+ `alternative`（计入所有 CLAIM 后重新计算的备选），用 `recompute:true` 提交。
* **取消**：未完成步骤的 CLAIM 释放为 AVAILABLE；已拔除的箱回到 FROZEN（仍占原插座、仍计掉电），可重新规划。

## 分时功率预算与冷藏负荷削峰

### 预算与合并
* 值班员登记**生效区间**与**两级安培上限**：`shipLimitA`（全船）与 `boardLimitsA`（配电板）。
* 多个预算区间重叠时按**最严格上限合并**（全船取最小、配电板逐板取最小），`endAt` 取最早结束；
  `GET /api/state` 的 `peak.budget.sourceBudgetIds` 标明当前上限由哪些区间合并而来。
* 任一下级（配电板）上限都不能被下级计划突破：规划与执行同时校核全船与每块板的净负载。

### 风险评估（依据新鲜读数 + 箱内温度趋势 + 设定温度 + 保冷余量 + 货物等级）
* 货物等级 `cargoGrade`：`PHARMA/HIGH`（高风险，**必须保护**，不允许任何削峰）、
  `FRESH/CHILLED`（中风险，只允许限功率、**不允许断电**）、`FROZEN/GENERAL`（低风险，可限功率可短时断电）。
* 温度画像取 10 分钟新鲜温度样本：当前箱温、相对 `setpointC` 的偏离、近 30 分钟回温趋势（℃/h）、
  保冷余量（相对 `allowableRiseC` 还能承受多少温升）。无新鲜温度读数时加不确定惩罚（按更危险处理）。
* 电流读数超过 5 分钟新鲜窗口时回退铭牌估算（与实时负载口径一致）。
* 短时断电时长 = 由保冷余量与回温速率推算的安全可断电时长，再留 1 分钟安全余量；
  不足 2 分钟则不安排断电并在 `skipReasons` 中给出 `UNSAFE_CUT`。

### 可执行方案（修订）
* **先限功率后断电**：规划器先尝试“仅限功率”能否达标（低风险箱最多压 65%、中风险 40%）；
  达不到才对低风险箱短时断电。每个动作给出**释放电流 `releaseA`、预计持续 `durationMin`、
  恢复最迟时刻 `restoreBy`**；不可行时在 `infeasibleReasons` 中按全船/配电板列出剩余缺口与原因。
* 一版方案中**每个箱至多一个最终动作**（限功率后若需升级断电，则只保留断电；
  仅当升级的是“已生效”限功率事实时才记录 `replacesActionId`，并把该限功率已节省电量一次性结算）。
* 方案以**修订号 + 内容摘要 `summary`** 发布；带旧 `expectedRev` 的操作返回 409 `REVISION_STALE`
  并带 `currentRev`；同一请求标识重复发送只产生一次结果（回放首次答复）。
* 执行只允许让净负载下降，不允许反弹升高（`LOAD_REBOUND_ON_EXECUTE`）；
  值班员可逐步执行，途中允许暂未达标，全部执行完应在预算内（`withinLimit`）。

### 失效重算与恢复
* 电流或温度变化使原计算失效时，`currentRevision.stale=true`（基线签名变化）；
  `recompute` **只撤销尚未执行(PENDING)的动作**并生成新修订，已生效的限功率/断电事实保留不消失。
* 预算结束后的恢复**按可用余量分批**，每批最多 `maxBatchSize` 台，**优先恢复温度风险更高的箱**
  （已到恢复最迟时刻的断电最先）。恢复进度以会话维度记录 `已恢复/总数`。
* 恢复途中收到更低上限：**暂停恢复**，在“已归还本批”的状态上重新计算并发布新修订，
  归还后不得越过有效预算；暂停批次前不会归还任何会导致越限的电流。
* 累计节省电量 `cumulativeEnergyAmin`（A·min）只在动作恢复（或限功率被断电升级）时一次性记账，绝不重复计算。

## 持久化与崩溃恢复

```
data/events.log      不可变流水，每行一个命令批次（JSON）：{seq,commandId,hash,facts[],reply,status}
data/snapshot.json   周期快照（Map/Set 结构化），tmp+rename 原子替换
```

* 批次先 `write+fsync` 整批落盘，再内存归并；不存在“半条命令”。末行撕裂在重启时截断丢弃。
* 故障注入（`--test-faults`）在 fsync 之后、归并之前 `exit(17)`，重启后从快照重放流水归并，
  并由 `assertInvariants` 校验：无双重占用、PENDING 步骤无漂移租约、COMPLETED 计划的箱必须 POWERED；
  **削峰侧另校验：每个箱至多一个 EFFECTIVE 动作、至多一个 PENDING 动作，动作取代/恢复引用一致**。
* 预算、方案修订、削峰动作（PENDING→EFFECTIVE→SUPERSEDED/RESTORED）、恢复批次与累计节省电量
  全部作为事实写入同一条流水与检查点；发布方案、执行限功率/断电、恢复批次三个边界注入崩溃后，
  重启得到唯一状态：同一箱不被重复控制、节省量不重复计算、实际负载不越过有效预算。
* 测试虚拟时钟的推进量也作为 `clockAdvanced` 事实落盘，重启后“当前时刻”一致。
* 快照中的首次答复随批次持久化，崩溃后用同一命令标识重试仍得到首次答复。
