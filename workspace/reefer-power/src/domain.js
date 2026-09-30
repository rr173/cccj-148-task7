'use strict';

import { normPhase, num, round2, nameplateCurrentA, bad, DomainError } from './util.js';

// 状态形态：
// {
//   boards:{id:{id,name}}, circuits:{id:{...}}, sockets:{id:{...}},
//   reefers:{id:{...}},
//   reservations:{socketId: {reeferId, leaseId}},   // RESERVE 租约的映射（活动）
//   leases:[ {id, reeferId, socketId, state, fromLeaseId?} ],
//   plans:{id:{...steps}},
//   samples:{ [key]:{...} },                        // 去重后的样本（含隔离/重复）
//   latestCurrent:{socketId:{...}}, powerLossAt:{reeferId:ts},
//   seq: number,
//
//   // —— 分时功率预算与冷藏负荷削峰 ——
//   budgets:[ {id,operatorId,startAt,endAt,shipLimitA,boardLimitsA,registeredAt,revokedAt} ],
//   budgetSeq, peakSeq,
//   revisions:[ {rev,operatorId,at,summary,status,basisSignature,budget:{...},feasible,...} ],
//   shavingActions:[
//     {id,rev,reeferId,boardId,kind,status:PENDING/EFFECTIVE/INVALIDATED/CANCELLED/SUPERSEDED/RESTORED,
//      gearFraction,plannedHeldA,heldA,basisCurrentA,currentA,releaseA,incrementalReleaseA,
//      durationMin,restoreBy,replacesActionId,supersededActionIds:[],executedAt,supersededAt,cancelledAt,restoredAt}
//   ],
//   restoreBatches:[ {id,at,sessionId,state,items,total,recoveredCount,paused,revisionPublished,energySavedAmin} ],
//   energySavedAmin                                   // 累计节省电量（A·min），仅恢复时一次性记账
//
//   // —— 装船前预冷合格证与放行互锁 ——
//   pcVoyages: Set<voyageId>,
//   powerEvents:[ {reeferId, at, kind:'powerLost'|'powerRestored', reason} ],
//   pcVersions: Map<"voyageId\0reeferId", number>,    // 聚合版本前置条件
//   observations:[ {id,voyageId,reeferId,sensorBootId,startedAt,state,supersededAt,supersededBy?} ],
//   certificates:[ {id,version,voyageId,reeferId,sensorBootId,issuedAt,status,
//       highRisk,params,evidence,observationId,invalidatedAt,invalidateReason,restartHint,operationId} ],
//   exemptions:[ {id,version,voyageId,reeferId,reason,cargoOwner,issuedAt,validUntil,status,
//       closedAt,revokedAt,revokeReason,operationId,closedByCertId?} ],
//   loadingHolds:[ {id,voyageId,reeferId,openedAt,state,slotCode,scannerId,resolution,resolvedAt,
//       releaseId?,basis?} ],
//   pcSeq                                            // 合格证域自增序号
// }
export function initialState() {
  return {
    boards: new Map(),
    circuits: new Map(),
    sockets: new Map(),
    reefers: new Map(),
    reservations: new Map(),
    leases: [],
    plans: new Map(),
    samples: new Map(),
    latestCurrent: new Map(),
    powerLossAt: new Map(),
    seq: 0,
    planSeq: 0,
    budgets: [],
    budgetSeq: 0,
    peakSeq: 0,
    revisions: [],
    shavingActions: [],
    restoreBatches: [],
    energySavedAmin: 0,
    pcVoyages: new Set(),
    powerEvents: [],
    pcVersions: new Map(),
    observations: [],
    certificates: [],
    exemptions: [],
    loadingHolds: [],
    pcSeq: 0,
  };
}

export function assertInvariants(s, tag) {
  // 任一时刻一个插座只能服务一个箱（活动租约唯一）
  const bySocket = new Map();
  const byReefer = new Map();
  for (const l of s.leases) {
    if (leaseClosed(l)) continue;
    const a = bySocket.get(l.socketId) || [];
    a.push(l);
    bySocket.set(l.socketId, a);
    const b = byReefer.get(l.reeferId) || [];
    b.push(l);
    byReefer.set(l.reeferId, b);
  }
  for (const [sid, ls] of bySocket) {
    if (ls.length > 1) {
      throw new Error(`不变量被破坏 (${tag}): 插座 ${sid} 双重占用 ${ls.map((l) => `${l.reeferId}:${l.state}`)}`);
    }
  }
  for (const [rid, ls] of byReefer) {
    // 迁移期间允许同一箱同时持有 FROZEN(原) 与 CLAIM(目标)，其余情况唯一
    const nonMigPair = ls.filter((l) => l.state !== 'FROZEN' && l.state !== 'CLAIM');
    if (nonMigPair.length > 1) {
      throw new Error(`不变量被破坏 (${tag}): 箱 ${rid} 占用多个插座`);
    }
    if (ls.length > 2) {
      throw new Error(`不变量被破坏 (${tag}): 箱 ${rid} 租约数 ${ls.length}`);
    }
    if (ls.length === 2) {
      const st = ls.map((l) => l.state).sort().join('+');
      // 迁移中间态：目标 CLAIM + 原 FROZEN（刚占位）或 UNPLUGGED（已拔除待送电）
      if (st !== 'CLAIM+FROZEN' && st !== 'CLAIM+UNPLUGGED') {
        throw new Error(`不变量被破坏 (${tag}): 箱 ${rid} 非法租约组合 ${st}`);
      }
    }
  }
  // 预留映射与租约一致
  for (const [sid, r] of s.reservations) {
    const l = leaseById(s, r.leaseId);
    if (!l || leaseClosed(l) || l.socketId !== sid) throw new Error(`不变量被破坏 (${tag}): 预留映射漂移 ${sid}`);
  }
  // 计划步骤状态一致性
  for (const plan of s.plans.values()) {
    for (const st of plan.steps) {
      if (st.state === 'PENDING') {
        // 步骤 0 在方案创建时即预占目标插座（CLAIM），属设计内状态
        if (st.claimLeaseId && st.occupyCommitted) continue;
        if (st.claimLeaseId) throw new Error(`不变量被破坏 (${tag}): PENDING 步骤持有租约`);
      }
      if (st.state === 'DONE') {
        const l = leaseById(s, st.newLeaseId);
        if (!l || l.state !== 'POWER' || l.socketId !== st.targetSocketId) {
          throw new Error(`不变量被破坏 (${tag}): 计划 ${plan.id} 步骤 ${st.index} 已完成但目标未送电`);
        }
      }
    }
    if (plan.state === 'COMPLETED') {
      for (const reeferId of plan.reeferIds) {
        const r = s.reefers.get(reeferId);
        if (r && !poweredLease(s, reeferId)) {
          throw new Error(`不变量被破坏 (${tag}): 计划 ${plan.id} 已完成但箱 ${reeferId} 仍断电`);
        }
      }
    }
  }

  // —— 削峰不变量 ——
  // 每个箱至多一个已生效动作、至多一个待执行动作；
  // 待执行“升级断电”允许与已生效限功率短暂并存（此时箱由已生效动作控制）。
  const effByReefer = new Map();
  const pendByReefer = new Map();
  for (const a of s.shavingActions) {
    if (a.status === 'EFFECTIVE') {
      const cur = effByReefer.get(a.reeferId);
      if (cur) throw new Error(`不变量被破坏 (${tag}): 箱 ${a.reeferId} 有两个生效削峰动作 ${cur} / ${a.id}`);
      effByReefer.set(a.reeferId, a.id);
    }
    if (a.status === 'PENDING') {
      const cur = pendByReefer.get(a.reeferId);
      if (cur) throw new Error(`不变量被破坏 (${tag}): 箱 ${a.reeferId} 有两个待执行动作 ${cur} / ${a.id}`);
      pendByReefer.set(a.reeferId, a.id);
    }
    if (a.replacesActionId) {
      const old = s.shavingActions.find((x) => x.id === a.replacesActionId);
      if (!old || old.reeferId !== a.reeferId) {
        throw new Error(`不变量被破坏 (${tag}): 动作 ${a.id} 的 replacesActionId 引用非法`);
      }
    }
    for (const sid of a.supersededActionIds || []) {
      const old = s.shavingActions.find((x) => x.id === sid);
      if (!old || old.reeferId !== a.reeferId || old.status !== 'SUPERSEDED') {
        throw new Error(`不变量被破坏 (${tag}): 动作 ${a.id} 标记的取代动作 ${sid} 不一致`);
      }
    }
  }

  // —— 预冷合格证 / 豁免 / 待处理 不变量 ——
  const certByKey = new Map();
  for (const c of s.certificates) {
    if (c.status !== 'ISSUED') continue;
    const k = pcKey(c.voyageId, c.reeferId);
    if (certByKey.has(k)) {
      throw new Error(`不变量被破坏 (${tag}): ${k} 存在两张有效合格证 ${certByKey.get(k)} / ${c.id}`);
    }
    certByKey.set(k, c.id);
  }
  const exByKey = new Map();
  for (const e of s.exemptions) {
    if (e.status !== 'ACTIVE') continue;
    const k = pcKey(e.voyageId, e.reeferId);
    if (exByKey.has(k)) {
      throw new Error(`不变量被破坏 (${tag}): ${k} 存在两张有效豁免 ${exByKey.get(k)} / ${e.id}`);
    }
    exByKey.set(k, e.id);
    // 有效豁免与有效合格证不并存（签发合格证即关闭豁免）
    if (certByKey.has(k)) {
      throw new Error(`不变量被破坏 (${tag}): ${k} 有效豁免 ${e.id} 与有效合格证 ${certByKey.get(k)} 并存`);
    }
  }
  const holdByKey = new Set();
  for (const h of s.loadingHolds) {
    if (h.state !== 'OPEN') continue;
    const k = pcKey(h.voyageId, h.reeferId);
    if (holdByKey.has(k)) throw new Error(`不变量被破坏 (${tag}): ${k} 存在两条 OPEN 待处理记录`);
    holdByKey.add(k);
  }
  const obsByKey = new Set();
  for (const o of s.observations) {
    if (o.state !== 'ACTIVE') continue;
    const k = pcKey(o.voyageId, o.reeferId);
    if (obsByKey.has(k)) throw new Error(`不变量被破坏 (${tag}): ${k} 存在两个活动观测`);
    obsByKey.add(k);
  }
}

export function leaseClosed(l) {
  return l.state === 'RELEASED' || l.state === 'SUPERSEDED';
}
export function activeLeases(s) {
  return s.leases.filter((l) => !leaseClosed(l));
}
export function leaseById(s, id) {
  return s.leases.find((l) => l.id === id) || null;
}
export function activeLeaseOnSocket(s, socketId) {
  return s.leases.find((l) => l.socketId === socketId && !leaseClosed(l)) || null;
}
export function activeLeaseOfReefer(s, reeferId) {
  return s.leases.find((l) => l.reeferId === reeferId && !leaseClosed(l)) || null;
}
export function activeLeasesOfReefer(s, reeferId) {
  return s.leases.filter((l) => l.reeferId === reeferId && !leaseClosed(l));
}
export function poweredLease(s, reeferId) {
  return s.leases.find((l) => l.reeferId === reeferId && l.state === 'POWER') || null;
}

// ---------- 事实归并（确定性纯函数） ----------
export function applyFact(s, fact) {
  switch (fact.type) {
    case 'topologyImported': return applyTopology(s, fact);
    case 'reefersImported': return applyReefers(s, fact);
    case 'reserved': return applyReserved(s, fact);
    case 'powered': return applyPowered(s, fact);
    case 'sampleRecorded': return applySample(s, fact);
    case 'tripped': return applyTripped(s, fact);
    case 'circuitReset': return applyReset(s, fact);
    case 'migrationCreated': return applyMigrationCreated(s, fact);
    case 'stepAdvanced': return applyStepAdvanced(s, fact);
    case 'migrationCancelled': return applyMigrationCancelled(s, fact);
    case 'clockAdvanced': return s; // 仅用于持久化测试虚拟时钟偏移（store 负责 setClockOffset）
    case 'budgetRegistered': return applyBudgetRegistered(s, fact);
    case 'budgetRevoked': return applyBudgetRevoked(s, fact);
    case 'peakPlanPublished': return applyPeakPlanPublished(s, fact);
    case 'shavingActionExecuted': return applyShavingActionExecuted(s, fact);
    case 'shavingActionsInvalidated': return applyShavingActionsInvalidated(s, fact);
    case 'shavingActionsCancelled': return applyShavingActionsCancelled(s, fact);
    case 'restoreBatchRecorded': return applyRestoreBatch(s, fact);
    case 'voyageRegistered': return applyVoyageRegistered(s, fact);
    case 'setpointAdjusted': return applySetpointAdjusted(s, fact);
    case 'powerEventRecorded': return applyPowerEvent(s, fact);
    case 'observationStarted': return applyObservationStarted(s, fact);
    case 'observationSuperseded': return applyObservationSuperseded(s, fact);
    case 'certificateIssued': return applyCertificateIssued(s, fact);
    case 'certificateInvalidated': return applyCertificateInvalidated(s, fact);
    case 'exemptionIssued': return applyExemptionIssued(s, fact);
    case 'exemptionClosed': return applyExemptionClosed(s, fact);
    case 'loadingHoldRecorded': return applyLoadingHold(s, fact);
    default:
      throw new Error(`未知事实类型: ${fact.type}`);
  }
}

function nextLeaseId(s) {
  s.seq += 1;
  return `L${String(s.seq).padStart(5, '0')}`;
}

function applyTopology(s, f) {
  for (const b of f.boards) {
    s.boards.set(b.id, { id: b.id, name: b.name });
  }
  for (const c of f.circuits) {
    const prev = s.circuits.get(c.id);
    s.circuits.set(c.id, {
      id: c.id,
      boardId: c.boardId,
      name: c.name,
      phase: normPhase(c.phase),
      ratedCurrentA: num(c.ratedCurrentA, '回路额定电流', { min: 0.1 }),
      state: prev?.state === 'TRIPPED' ? 'TRIPPED' : 'NORMAL',
      trippedAt: prev?.trippedAt || null,
    });
  }
  for (const sk of f.sockets) {
    const circuit = s.circuits.get(sk.circuitId);
    if (!circuit) throw new Error(`插座 ${sk.id} 引用了未知回路 ${sk.circuitId}`);
    s.sockets.set(sk.id, {
      id: sk.id,
      circuitId: sk.circuitId,
      name: sk.name,
      phase: sk.phase ? normPhase(sk.phase) : circuit.phase,
      ratedCurrentA: sk.ratedCurrentA != null
        ? num(sk.ratedCurrentA, '插座额定电流', { min: 0.1 })
        : circuit.ratedCurrentA,
      allowedBoxTypes: sk.allowedBoxTypes,
      reachAreas: sk.reachAreas,
    });
  }
  return s;
}

function applyReefers(s, f) {
  for (const r of f.reefers) {
    const phase = normPhase(r.phase);
    s.reefers.set(r.id, {
      id: r.id,
      boxType: r.boxType,
      phase,
      ratedCurrentA: r.ratedCurrentA != null
        ? round2(num(r.ratedCurrentA, '箱额定电流', { min: 0.1 }))
        : nameplateCurrentA(r.powerKw, phase),
      powerKw: r.powerKw != null ? Number(r.powerKw) : null,
      area: r.area,
      tempPriority: num(r.tempPriority, '温控优先级', { min: 1, max: 99, integer: true }),
      insulationHours: num(r.insulationHours, '保温时限(小时)', { min: 0.01 }),
      setpointC: r.setpointC != null ? Number(r.setpointC) : null,
      cargoGrade: String(r.cargoGrade ?? 'GENERAL').toUpperCase(),
      allowableRiseC: r.allowableRiseC != null ? num(r.allowableRiseC, '允许温升(℃)', { min: 0.1 }) : null,
    });
  }
  return s;
}

function applyReserved(s, f) {
  const reefer = s.reefers.get(f.reeferId);
  const socket = s.sockets.get(f.socketId);
  if (!reefer || !socket) throw new Error('预留事实引用了未知箱或插座');
  if (activeLeaseOnSocket(s, f.socketId)) throw new Error('预留事实与既有插座租约冲突');
  if (activeLeaseOfReefer(s, f.reeferId)) throw new Error('预留事实与既有箱租约冲突');
  const leaseId = nextLeaseId(s);
  s.leases.push({ id: leaseId, reeferId: f.reeferId, socketId: f.socketId, state: 'RESERVE' });
  s.reservations.set(f.socketId, { reeferId: f.reeferId, leaseId });
  return s;
}

function applyPowered(s, f) {
  const lease = leaseById(s, f.leaseId);
  if (!lease || lease.state !== 'RESERVE') throw new Error('送电事实要求 RESERVE 租约');
  lease.state = 'POWER';
  s.reservations.delete(lease.socketId);
  return s;
}

function applySample(s, f) {
  s.samples.set(f.key, {
    key: f.key,
    kind: f.kind,
    sensorBootId: f.sensorBootId,
    reeferId: f.reeferId ?? null,
    socketId: f.socketId ?? null,
    circuitId: f.circuitId ?? null,
    measuredAt: f.measuredAt,
    receivedAt: f.receivedAt,
    value: f.value,
    accepted: f.accepted,
    reason: f.reason,
  });
  if (f.accepted && f.kind === 'current' && f.socketId) {
    s.latestCurrent.set(f.socketId, { value: f.value, measuredAt: f.measuredAt });
  }
  if (f.accepted && f.kind === 'powerLoss' && f.reeferId) {
    const prev = s.powerLossAt.get(f.reeferId);
    if (prev == null || f.measuredAt > prev) s.powerLossAt.set(f.reeferId, f.measuredAt);
  }
  return s;
}

function applyTripped(s, f) {
  const c = s.circuits.get(f.circuitId);
  if (!c) throw new Error('跳闸事实引用未知回路');
  c.state = 'TRIPPED';
  c.trippedAt = f.at;
  for (const l of activeLeases(s)) {
    if (l.state !== 'POWER') continue;
    const sk = s.sockets.get(l.socketId);
    if (sk && sk.circuitId === f.circuitId) {
      l.state = 'FROZEN';
      if (s.powerLossAt.get(l.reeferId) == null) s.powerLossAt.set(l.reeferId, f.at);
    }
  }
  return s;
}

function applyReset(s, f) {
  const c = s.circuits.get(f.circuitId);
  if (!c) throw new Error('复位事实引用未知回路');
  c.state = 'NORMAL';
  c.trippedAt = null;
  for (const l of activeLeases(s)) {
    if (l.state !== 'FROZEN') continue;
    const sk = s.sockets.get(l.socketId);
    if (sk && sk.circuitId === f.circuitId) {
      // 该箱若正处于迁移中（目标已 CLAIM），不就地恢复，避免 POWER+CLAIM 双租约
      const inMigration = s.leases.some(
        (x) => x.reeferId === l.reeferId && x.state === 'CLAIM'
      );
      if (inMigration) continue;
      l.state = 'POWER';
      s.powerLossAt.delete(l.reeferId);
    }
  }
  return s;
}

function applyMigrationCreated(s, f) {
  if (s.plans.has(f.planId)) throw new Error(`计划 ${f.planId} 已存在`);
  s.planSeq += 1;
  if (f.planId !== `P${String(s.planSeq).padStart(5, '0')}`) {
    throw new Error(`计划编号不确定: ${f.planId}`);
  }
  const steps = f.steps.map((st, i) => {
    if (st.occupyCommitted) {
      const claimId = nextLeaseId(s);
      s.leases.push({
        id: claimId,
        reeferId: st.reeferId,
        socketId: st.targetSocketId,
        state: 'CLAIM',
      });
      return { ...st, index: i, state: 'PENDING', claimLeaseId: claimId, newLeaseId: null };
    }
    return { ...st, index: i, state: 'PENDING', claimLeaseId: null, newLeaseId: null };
  });
  s.plans.set(f.planId, {
    id: f.planId,
    circuitId: f.circuitId,
    reeferIds: f.reeferIds,
    steps,
    state: 'ACTIVE',
    createdAt: f.at,
    completedAt: null,
    cancelledAt: null,
  });
  return s;
}

function applyStepAdvanced(s, f) {
  const plan = s.plans.get(f.planId);
  if (!plan) throw new Error('步骤事实引用未知计划');
  const st = plan.steps[f.index];
  if (!st) throw new Error('步骤事实索引越界');

  if (f.action === 'unplug') {
    const orig = leaseById(s, f.leaseId);
    if (!orig || orig.state !== 'FROZEN') throw new Error('拔除要求 FROZEN 租约');
    orig.state = 'UNPLUGGED';
    st.state = 'UNPLUGGED';
  } else if (f.action === 'occupy') {
    const claimId = nextLeaseId(s);
    s.leases.push({
      id: claimId,
      reeferId: st.reeferId,
      socketId: st.targetSocketId,
      state: 'CLAIM',
    });
    st.claimLeaseId = claimId;
    st.state = 'OCCUPIED';
  } else if (f.action === 'repower') {
    if (st.claimLeaseId) {
      const claim = leaseById(s, st.claimLeaseId);
      if (!claim || claim.state !== 'CLAIM') throw new Error('送电要求 CLAIM 租约');
      claim.state = 'POWER';
      st.newLeaseId = claim.id;
    } else {
      // 同一插座复位送电（步骤 0 或原=目标）
      const orig = leaseById(s, f.leaseId);
      if (!orig || (orig.state !== 'FROZEN' && orig.state !== 'UNPLUGGED')) {
        throw new Error('送电要求 FROZEN/UNPLUGGED 租约');
      }
      orig.state = 'POWER';
      st.newLeaseId = orig.id;
    }
    const oldLease = leaseById(s, f.oldLeaseId);
    if (oldLease && oldLease.id !== st.newLeaseId) {
      oldLease.state = 'SUPERSEDED';
      s.powerLossAt.delete(st.reeferId);
    }
    if (oldLease && oldLease.id === st.newLeaseId) {
      s.powerLossAt.delete(st.reeferId);
    }
    st.state = 'DONE';
  } else {
    throw new Error(`未知步骤动作: ${f.action}`);
  }

  if (plan.steps.every((x) => x.state === 'DONE')) {
    plan.state = 'COMPLETED';
    plan.completedAt = f.at;
  }
  return s;
}

function applyMigrationCancelled(s, f) {
  const plan = s.plans.get(f.planId);
  if (!plan) throw new Error('取消事实引用未知计划');
  for (const st of plan.steps) {
    if (st.state === 'DONE') continue;
    if (st.claimLeaseId) {
      const claim = leaseById(s, st.claimLeaseId);
      if (claim && claim.state === 'CLAIM') {
        claim.state = 'RELEASED';
        st.claimLeaseId = null;
      }
    }
    // 已拔除但未完成：回到 FROZEN，箱仍处于断电（原插座未释放）
    const orig = s.leases.find(
      (l) => l.reeferId === st.reeferId && l.socketId === st.fromSocketId && (l.state === 'UNPLUGGED' || l.state === 'FROZEN')
    );
    if (orig) {
      orig.state = 'FROZEN';
      st.state = 'CANCELLED';
    } else if (st.state !== 'CANCELLED') {
      st.state = 'CANCELLED';
    }
  }
  plan.state = 'CANCELLED';
  plan.cancelledAt = f.at;
  return s;
}

export { bad, DomainError };

// ============================================================================
// 分时功率预算与冷藏负荷削峰：事实归并（确定性纯函数）
// ============================================================================
function nextBudgetId(s) {
  s.budgetSeq += 1;
  return `BG${String(s.budgetSeq).padStart(4, '0')}`;
}
function nextActionId(s) {
  s.peakSeq += 1;
  return `A${String(s.peakSeq).padStart(5, '0')}`;
}
function nextBatchId(s) {
  s.peakSeq += 1;
  return `RB${String(s.peakSeq).padStart(5, '0')}`;
}

function applyBudgetRegistered(s, f) {
  if (s.budgets.some((b) => b.id === f.budgetId)) throw new Error(`预算 ${f.budgetId} 已存在`);
  s.budgetSeq += 1;
  if (f.budgetId !== `BG${String(s.budgetSeq).padStart(4, '0')}`) {
    throw new Error(`预算编号不确定: ${f.budgetId}`);
  }
  s.budgets.push({
    id: f.budgetId,
    operatorId: f.operatorId,
    startAt: f.startAt,
    endAt: f.endAt,
    shipLimitA: f.shipLimitA,
    boardLimitsA: f.boardLimitsA || {},
    registeredAt: f.at,
    revokedAt: null,
  });
  return s;
}

function applyBudgetRevoked(s, f) {
  const b = s.budgets.find((x) => x.id === f.budgetId);
  if (!b) throw new Error('撤销事实引用未知预算');
  if (b.revokedAt) return s; // 幂等
  b.revokedAt = f.at;
  return s;
}

// 发布削峰修订：把上一版尚未执行(PENDING)的动作整体作废旧版本号；
// 已经生效(EFFECTIVE)的限功率/断电事实保留。每个动作生成稳定标识。
function applyPeakPlanPublished(s, f) {
  if (s.revisions.some((r) => r.rev === f.rev)) throw new Error(`修订号 ${f.rev} 已存在`);
  const prevActive = f.supersedesRev || (s.revisions.length ? s.revisions[s.revisions.length - 1].rev : 0);

  // 旧修订中尚未执行的动作撤销（仅撤销未执行动作，已生效事实不消失）
  for (const a of s.shavingActions) {
    if (a.status === 'PENDING' && a.rev === prevActive) {
      a.status = 'INVALIDATED';
      a.invalidatedAt = f.at;
      a.invalidateReason = 'SUPERSEDED_BY_REVISION';
      a.invalidatedByRev = f.rev;
    }
  }

  for (const act of f.actions) {
    const id = nextActionId(s);
    s.shavingActions.push({
      id,
      rev: f.rev,
      reeferId: act.reeferId,
      boardId: act.boardId,
      socketId: act.socketId || null,
      circuitId: act.circuitId || null,
      kind: act.kind,
      status: 'PENDING',
      gearFraction: act.gearFraction ?? null,
      plannedHeldA: act.plannedHeldA ?? act.releaseA ?? null,
      basisCurrentA: act.basisCurrentA ?? null,
      releaseA: act.releaseA ?? null,
      incrementalReleaseA: act.incrementalReleaseA ?? null,
      durationMin: act.durationMin ?? null,
      restoreBy: act.restoreBy ?? null,
      safeCutMinutes: act.safeCutMinutes ?? null,
      replacesActionId: act.replacesActionId || null,
      supersededActionIds: [],
      executedAt: null,
      supersededAt: null,
      cancelledAt: null,
      invalidatedAt: null,
      restoredAt: null,
    });
  }

  s.revisions.push({
    rev: f.rev,
    operatorId: f.operatorId,
    at: f.at,
    summary: f.summary,
    status: f.feasible ? 'FEASIBLE' : 'INFEASIBLE',
    feasible: f.feasible,
    basisSignature: f.basisSignature,
    budget: f.budget,
    actionIds: [],
    actionDigests: f.actions.map((a) => `${a.kind}:${a.reeferId}`),
    deficitsAfter: f.deficitsAfter || null,
    infeasibleReasons: f.infeasibleReasons || [],
    skipReasons: f.skipReasons || [],
  });
  const rev = s.revisions[s.revisions.length - 1];
  rev.actionIds = s.shavingActions.filter((a) => a.rev === f.rev).map((a) => a.id);
  return s;
}

function getAction(s, actionId) {
  const a = s.shavingActions.find((x) => x.id === actionId);
  if (!a) throw new Error(`削峰动作不存在: ${actionId}`);
  return a;
}

// 执行限功率/断电：PENDING -> EFFECTIVE。断电升级时既有 LIMIT 事实标记为 SUPERSEDED 保留。
function applyShavingActionExecuted(s, f) {
  const a = getAction(s, f.actionId);
  if (a.status !== 'PENDING') throw new Error(`动作 ${a.id} 当前为 ${a.status}，不能执行`);

  if (a.kind === 'CUT' && a.replacesActionId) {
    const old = getAction(s, a.replacesActionId);
    if (old.status !== 'EFFECTIVE') throw new Error(`升级断电要求原限功率 ${old.id} 已生效，实际 ${old.status}`);
    // 被取代的限功率在退场时一次性结算已节省电量（与最终恢复结算互斥，不重复）
    const heldA = old.heldA ?? old.plannedHeldA ?? 0;
    const heldMin = Math.max(0, (f.at - (old.executedAt ?? f.at)) / 60000);
    s.energySavedAmin += heldA * heldMin;
    old.status = 'SUPERSEDED';
    old.supersededAt = f.at;
    old.supersededByActionId = a.id;
    old.energyAccruedAmin = round2(heldA * heldMin);
    a.supersededActionIds.push(old.id);
  }

  a.status = 'EFFECTIVE';
  a.executedAt = f.at;
  a.gearFraction = f.gearFraction ?? a.gearFraction;
  a.currentA = f.currentA;
  a.heldA = f.heldA;
  a.releaseA = f.releaseA;
  a.incrementalReleaseA = f.incrementalReleaseA ?? a.incrementalReleaseA;
  return s;
}

// 计划失效重算：只撤销尚未执行的 PENDING 动作（按修订过滤），已生效事实不消失
function applyShavingActionsInvalidated(s, f) {
  for (const id of f.actionIds) {
    const a = getAction(s, id);
    if (a.status !== 'PENDING') continue;
    a.status = 'INVALIDATED';
    a.invalidatedAt = f.at;
    a.invalidateReason = f.reason || 'RECALC';
    a.invalidatedByRev = f.byRev ?? null;
  }
  return s;
}

// 操作员手动撤销方案：同样只撤销未执行动作
function applyShavingActionsCancelled(s, f) {
  for (const id of f.actionIds) {
    const a = getAction(s, id);
    if (a.status !== 'PENDING') continue;
    a.status = 'CANCELLED';
    a.cancelledAt = f.at;
  }
  return s;
}

// 恢复批次：把动作置为 RESTORED，按其实际持有的释放量一次性累计节省电量
function applyRestoreBatch(s, f) {
  for (const item of f.items) {
    const a = getAction(s, item.actionId);
    if (a.status !== 'EFFECTIVE') throw new Error(`恢复要求动作 ${a.id} 已生效，实际 ${a.status}`);
    a.status = 'RESTORED';
    a.restoredAt = f.at;
    a.restoredBatchId = f.batchId;
    // 节省电量 = 实际释放电流(A) × 已执行时长(min)，仅在恢复时一次性记账，绝不重复
    const heldA = a.kind === 'LIMIT'
      ? (a.heldA ?? a.plannedHeldA ?? 0)
      : (a.releaseA ?? 0);
    const heldMin = Math.max(0, (f.at - (a.executedAt ?? f.at)) / 60000);
    s.energySavedAmin += heldA * heldMin;
  }
  s.restoreBatches.push({
    id: f.batchId,
    at: f.at,
    sessionId: f.sessionId,
    state: f.paused ? 'PAUSED' : (f.complete ? 'COMPLETED' : 'IN_PROGRESS'),
    items: f.items.map((x) => ({ ...x })),
    total: f.total,
    recoveredCount: f.recoveredCount,
    paused: f.paused,
    pauseReason: f.pauseReason || null,
    budgetActive: f.budgetActive,
    revisionPublished: f.revisionPublished || null,
  });
  return s;
}

// ============================================================================
// 装船前预冷合格证与放行互锁：事实归并（确定性纯函数）
// ============================================================================
function nextPcId(s, prefix) {
  s.pcSeq += 1;
  return `${prefix}${String(s.pcSeq).padStart(5, '0')}`;
}
export function pcKey(voyageId, reeferId) {
  return `${voyageId} ${reeferId}`;
}
export function pcVersion(s, voyageId, reeferId) {
  return s.pcVersions.get(pcKey(voyageId, reeferId)) ?? 0;
}
function bumpPcVersion(s, voyageId, reeferId) {
  const k = pcKey(voyageId, reeferId);
  const v = (s.pcVersions.get(k) ?? 0) + 1;
  s.pcVersions.set(k, v);
  return v;
}
export function activeObservation(s, voyageId, reeferId) {
  return s.observations.find(
    (o) => o.voyageId === voyageId && o.reeferId === reeferId && o.state === 'ACTIVE'
  ) || null;
}
export function issuedCert(s, voyageId, reeferId) {
  return s.certificates.find(
    (c) => c.voyageId === voyageId && c.reeferId === reeferId && c.status === 'ISSUED'
  ) || null;
}
export function activeExemption(s, voyageId, reeferId) {
  return s.exemptions.find(
    (e) => e.voyageId === voyageId && e.reeferId === reeferId && e.status === 'ACTIVE'
  ) || null;
}
export function openHold(s, voyageId, reeferId) {
  return s.loadingHolds.find(
    (h) => h.voyageId === voyageId && h.reeferId === reeferId && h.state === 'OPEN'
  ) || null;
}

function applyVoyageRegistered(s, f) {
  s.pcVoyages.add(f.voyageId);
  return s;
}

function applySetpointAdjusted(s, f) {
  const r = s.reefers.get(f.reeferId);
  if (!r) throw new Error(`设定点调整引用未知箱 ${f.reeferId}`);
  r.setpointC = Number(f.setpointC);
  r.setpointChangedAt = f.at;
  return s;
}

function applyPowerEvent(s, f) {
  // 同一(箱,时刻,kind)去重，保证反应式事实重放幂等
  const dup = s.powerEvents.some(
    (e) => e.reeferId === f.reeferId && e.at === f.at && e.kind === f.kind
  );
  if (dup) return s;
  s.powerEvents.push({ reeferId: f.reeferId, at: f.at, kind: f.kind, reason: f.reason || null });
  return s;
}

function applyObservationStarted(s, f) {
  // 编号在归并时确定性自分配，避免与同批反应事实争用序号
  if (f.observationId) {
    if (s.observations.some((o) => o.id === f.observationId)) return s;
  }
  const id = f.observationId || nextPcId(s, 'OB');
  // 同(航次,箱)只保留一个活动观测：旧观测被取代（保留行用于审计与证据追溯）
  for (const o of s.observations) {
    if (o.voyageId === f.voyageId && o.reeferId === f.reeferId && o.state === 'ACTIVE') {
      o.state = 'SUPERSEDED';
      o.supersededAt = f.at;
      o.supersededBy = id;
      o.supersedeReason = f.reason || 'RESTARTED';
    }
  }
  if (s.observations.some((o) => o.id === id)) return s;
  s.observations.push({
    id,
    voyageId: f.voyageId,
    reeferId: f.reeferId,
    sensorBootId: f.sensorBootId,
    startedAt: f.startedAt,
    state: 'ACTIVE',
    supersededAt: null,
    supersedeReason: null,
  });
  bumpPcVersion(s, f.voyageId, f.reeferId);
  return s;
}

// 反应式：掉电 / 传感器更换 / 设定点调整时把进行中的观测作废（保留行用于审计）。
function applyObservationSuperseded(s, f) {
  for (const o of s.observations) {
    if (o.id !== f.observationId) continue;
    if (o.state !== 'ACTIVE') return s; // 幂等
    o.state = 'SUPERSEDED';
    o.supersededAt = f.at;
    o.supersedeReason = f.reason;
    if (f.bySensorBootId) o.bySensorBootId = f.bySensorBootId;
    bumpPcVersion(s, o.voyageId, o.reeferId);
    return s;
  }
  return s;
}

function applyCertificateIssued(s, f) {
  if (f.certificateId && s.certificates.some((c) => c.id === f.certificateId)) return s;
  const id = f.certificateId || nextPcId(s, 'PC');
  // 单一有效证书：既有 ISSUED 证书必须已先被作废（同批 reaction 保证）。
  // 此处防御性检查，违反即不变量错误，绝不静默签出第二张。
  const existing = issuedCert(s, f.voyageId, f.reeferId);
  if (existing) throw new Error(`箱 ${f.reeferId} 在航次 ${f.voyageId} 已存在有效合格证 ${existing.id}`);

  const version = pcVersion(s, f.voyageId, f.reeferId);
  s.certificates.push({
    id,
    version,
    voyageId: f.voyageId,
    reeferId: f.reeferId,
    sensorBootId: f.sensorBootId,
    setpointC: f.setpointC,
    issuedAt: f.at,
    status: 'ISSUED',
    highRisk: !!f.highRisk,
    params: { ...f.params },
    evidence: { ...f.evidence },
    observationId: f.observationId,
    operatorId: f.operatorId,
    operationId: f.operationId,
    invalidatedAt: null,
    invalidateReason: null,
    restartHint: null,
  });

  // 签发合格证时关闭该(航次,箱)仍 ACTIVE 的临时豁免（豁免是放行的替代依据）
  for (const e of s.exemptions) {
    if (e.voyageId === f.voyageId && e.reeferId === f.reeferId && e.status === 'ACTIVE') {
      e.status = 'CLOSED';
      e.closedAt = f.at;
      e.closedByCertId = id;
    }
  }
  bumpPcVersion(s, f.voyageId, f.reeferId);
  return s;
}

function applyCertificateInvalidated(s, f) {
  const c = s.certificates.find((x) => x.id === f.certificateId);
  if (!c) throw new Error(`作废事实引用未知合格证 ${f.certificateId}`);
  // 失效是单向终态：已失效证书不能重新变为有效；重复作废幂等
  if (c.status === 'INVALID') return s;
  c.status = 'INVALID';
  c.invalidatedAt = f.at;
  c.invalidateReason = f.reason;
  c.restartHint = f.restartHint
    ? { ...f.restartHint }
    : { restartFromAt: f.at, remainingMs: c.params.requiredStableMs ?? null };
  bumpPcVersion(s, c.voyageId, c.reeferId);
  return s;
}

function applyExemptionIssued(s, f) {
  if (f.exemptionId && s.exemptions.some((e) => e.id === f.exemptionId)) return s;
  const id = f.exemptionId || nextPcId(s, 'EX');
  if (activeExemption(s, f.voyageId, f.reeferId)) {
    throw new Error(`箱 ${f.reeferId} 在航次 ${f.voyageId} 已存在有效豁免`);
  }
  const version = pcVersion(s, f.voyageId, f.reeferId);
  s.exemptions.push({
    id,
    version,
    voyageId: f.voyageId,
    reeferId: f.reeferId,
    reason: f.reason,
    cargoOwner: f.cargoOwner,
    issuedAt: f.at,
    validUntil: f.validUntil,
    durationMs: f.validUntil - f.at,
    status: 'ACTIVE',
    operatorId: f.operatorId,
    operationId: f.operationId,
    highRisk: !!f.highRisk,
    closedAt: null,
    revokedAt: null,
    revokeReason: null,
    closedByCertId: null,
  });
  bumpPcVersion(s, f.voyageId, f.reeferId);
  return s;
}

// 豁免终态：CLOSED（合格证签发覆盖）/ REVOKED（后续超温、掉电或到期）
function applyExemptionClosed(s, f) {
  const e = s.exemptions.find((x) => x.id === f.exemptionId);
  if (!e) throw new Error(`豁免关闭事实引用未知豁免 ${f.exemptionId}`);
  if (e.status !== 'ACTIVE') return s; // 幂等
  e.status = f.terminal === 'CLOSED' ? 'CLOSED' : 'REVOKED';
  if (e.status === 'REVOKED') {
    e.revokedAt = f.at;
    e.revokeReason = f.reason || 'AUTO_REVOKED';
  } else {
    e.closedAt = f.at;
    e.closedByCertId = f.certId || e.closedByCertId || null;
  }
  bumpPcVersion(s, e.voyageId, e.reeferId);
  return s;
}

function applyLoadingHold(s, f) {
  if (f.event === 'opened') {
    if (f.holdId && s.loadingHolds.some((h) => h.id === f.holdId)) return s;
    const id = f.holdId || nextPcId(s, 'HD');
    if (openHold(s, f.voyageId, f.reeferId)) throw new Error(`箱 ${f.reeferId} 在航次 ${f.voyageId} 已有待处理记录`);
    s.loadingHolds.push({
      id,
      voyageId: f.voyageId,
      reeferId: f.reeferId,
      openedAt: f.at,
      state: 'OPEN',
      slotCode: f.slotCode ?? null,
      scannerId: f.scannerId ?? null,
      reason: f.reason ?? null,
      resolution: null,
      resolvedAt: null,
      releaseId: null,
      basis: null,
    });
    bumpPcVersion(s, f.voyageId, f.reeferId);
    return s;
  }
  // resolved
  const h = s.loadingHolds.find((x) => x.id === f.holdId);
  if (!h) throw new Error(`待处理解决事实引用未知记录 ${f.holdId}`);
  if (h.state !== 'OPEN') return s; // 幂等
  h.state = 'RESOLVED';
  h.resolvedAt = f.at;
  h.resolution = f.resolution;
  h.releaseId = f.releaseId ?? null;
  h.basis = f.basis ?? null;
  bumpPcVersion(s, h.voyageId, h.reeferId);
  return s;
}
