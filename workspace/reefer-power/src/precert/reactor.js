'use strict';

// 反应式归并：每条命令批次落盘前，根据其业务事实推导“自动失效/撤销/掉电事件”。
// 反应事实与业务事实在同一批次原子落盘，因此“证书签发/样本落盘”与其引发的
// “自动失效/豁免撤销”不可能撕裂；重启重放时以 (base, folded) 重新确定性推导，
// 结果唯一。绝不基于读模型做写后补偿——所有终态都来自流水事实。

import {
  issuedCert,
  activeExemption,
  activeObservation,
} from '../domain.js';
import { cargoTier } from '../peak/risk.js';
import {
  precertParams,
  latestTemp,
} from './evaluate.js';

function isPowered(s, reeferId) {
  return s.leases.some((l) => l.reeferId === reeferId && l.state === 'POWER');
}
function isPowerLoss(s, reeferId) {
  // FROZEN（跳闸）/UNPLUGGED（迁移拔除）均视为掉电；没有任何租约不算（从未接电）
  return s.leases.some(
    (l) => l.reeferId === reeferId && (l.state === 'FROZEN' || l.state === 'UNPLUGGED')
  );
}
function batchAffectedReefers(base, folded, batchFacts) {
  const ids = new Set();
  for (const l of folded.leases) ids.add(l.reeferId);
  for (const l of base.leases) ids.add(l.reeferId);
  for (const f of batchFacts) {
    if (f.reeferId) ids.add(f.reeferId);
    if (f.leaseId) {
      const l = folded.leases.find((x) => x.id === f.leaseId) || base.leases.find((x) => x.id === f.leaseId);
      if (l) ids.add(l.reeferId);
    }
  }
  return ids;
}

function certRestartHint(cert, reason, at) {
  const remaining = cert.params?.requiredStableMs ?? null;
  return { restartFromAt: at, remainingMs: remaining, reason };
}

// 返回需要追加到本批次的反应式事实数组（纯函数；幂等由 applyFact 去重保证）
export function deriveReactionFacts(base, folded, batchFacts, at) {
  const facts = [];
  const affected = batchAffectedReefers(base, folded, batchFacts);

  // ---------- 1) 供电连续性：掉电 / 恢复 ----------
  for (const rid of affected) {
    const wasPowered = isPowered(base, rid);
    const nowPowered = isPowered(folded, rid);
    const nowLoss = isPowerLoss(folded, rid);
    const wasLoss = isPowerLoss(base, rid);

    if (wasPowered && !nowPowered && nowLoss) {
      facts.push({ type: 'powerEventRecorded', at, reeferId: rid, kind: 'powerLost', reason: 'LEASE_STATE' });
      invalidateForReefer(facts, folded, rid, at, 'POWER_LOSS', {
        restartFromAt: at,
        remainingMs: null,
        note: '期间发生掉电：恢复供电后由值班员重新发起观测并重新计时',
      });
      supersedeObservation(facts, folded, rid, at, 'POWER_LOSS');
    } else if (!wasPowered && nowPowered && (wasLoss || base.powerEvents?.some((e) => e.reeferId === rid && e.kind === 'powerLost'))) {
      facts.push({ type: 'powerEventRecorded', at, reeferId: rid, kind: 'powerRestored', reason: 'LEASE_STATE' });
    }
  }

  // 传感器样本显式上报掉电 / 恢复（租约状态未变化也要记账）
  for (const f of batchFacts) {
    if (f.type !== 'sampleRecorded' || !f.accepted || f.kind !== 'powerloss' || !f.reeferId) continue;
    const rid = f.reeferId;
    facts.push({ type: 'powerEventRecorded', at: f.measuredAt, reeferId: rid, kind: 'powerLost', reason: 'SENSOR' });
    invalidateForReefer(facts, folded, rid, f.measuredAt, 'POWER_LOSS', {
      restartFromAt: f.measuredAt,
      remainingMs: null,
      note: '传感器上报掉电：确认恢复供电后重新观测',
    });
    supersedeObservation(facts, folded, rid, f.measuredAt, 'POWER_LOSS');
  }

  // ---------- 2) 传感器更换 ----------
  for (const f of batchFacts) {
    if (f.type !== 'sampleRecorded' || !f.accepted || f.kind !== 'temperature' || !f.reeferId) continue;
    const rid = f.reeferId;
    // 该箱此前已接受温度读数的 boot 集合
    const prevBoots = new Set();
    for (const smp of base.samples.values()) {
      if (smp.accepted && smp.kind === 'temperature' && smp.reeferId === rid) prevBoots.add(smp.sensorBootId);
    }
    if (prevBoots.size && !prevBoots.has(f.sensorBootId)) {
      // 新 boot 出现即视为传感器更换：旧证书立即失效，旧观测作废
      for (const voyageId of pcVoyagesOf(folded, rid)) {
        const cert = issuedCert(folded, voyageId, rid);
        if (cert) {
          facts.push({
            type: 'certificateInvalidated', at, certificateId: cert.id,
            reason: 'SENSOR_REPLACED',
            restartHint: {
              restartFromAt: f.measuredAt,
              remainingMs: cert.params?.requiredStableMs ?? null,
              previousSensorBootId: cert.sensorBootId,
              currentSensorBootId: f.sensorBootId,
              note: '传感器已更换：以新传感器启动代号重新观测',
            },
          });
        }
        const obs = activeObservation(folded, voyageId, rid);
        if (obs && obs.sensorBootId !== f.sensorBootId) {
          facts.push({
            type: 'observationSuperseded', at, observationId: obs.id,
            reason: 'SENSOR_REPLACED', bySensorBootId: f.sensorBootId,
          });
        }
      }
    }
  }

  // ---------- 3) 设定点调整 ----------
  for (const f of batchFacts) {
    if (f.type !== 'setpointAdjusted') continue;
    const rid = f.reeferId;
    for (const voyageId of pcVoyagesOf(folded, rid)) {
      const cert = issuedCert(folded, voyageId, rid);
      if (cert) {
        facts.push({
          type: 'certificateInvalidated', at, certificateId: cert.id,
          reason: 'SETPOINT_CHANGED',
          restartHint: {
            restartFromAt: f.at,
            remainingMs: cert.params?.requiredStableMs ?? null,
            previousSetpointC: cert.setpointC,
            currentSetpointC: f.setpointC,
            note: '设定点已调整：以新设定点重新观测整个稳定时间窗',
          },
        });
      }
      const obs = activeObservation(folded, voyageId, rid);
      if (obs) facts.push({ type: 'observationSuperseded', at, observationId: obs.id, reason: 'SETPOINT_CHANGED' });
    }
  }

  // ---------- 4) 新温度读数导致超温：证书失效 + 豁免自动撤销 ----------
  for (const f of batchFacts) {
    if (f.type !== 'sampleRecorded' || !f.accepted || f.kind !== 'temperature' || !f.reeferId) continue;
    const rid = f.reeferId;
    const reefer = folded.reefers.get(rid);
    if (!reefer || reefer.setpointC == null) continue;
    const tier = cargoTier(reefer.cargoGrade);
    const p = precertParams(tier);
    if (Math.abs(f.value - Number(reefer.setpointC)) <= p.maxDeviationC + 1e-9) continue;

    for (const voyageId of pcVoyagesOf(folded, rid)) {
      const cert = issuedCert(folded, voyageId, rid);
      if (cert && cert.sensorBootId === f.sensorBootId) {
        facts.push({
          type: 'certificateInvalidated', at, certificateId: cert.id,
          reason: 'TEMP_EXCURSION',
          restartHint: {
            restartFromAt: f.measuredAt,
            remainingMs: cert.params?.requiredStableMs ?? null,
            currentC: f.value,
            setpointC: Number(reefer.setpointC),
            maxDeviationC: p.maxDeviationC,
            note: '观测/放行后出现新的超温读数：重新计时',
          },
        });
      }
      const ex = activeExemption(folded, voyageId, rid);
      // 豁免只覆盖到签发时刻：签发之后出现的超温立即自动撤销（豁免自身事实同批除外）
      if (ex && f.measuredAt >= ex.issuedAt && !facts.some((x) => x.type === 'exemptionIssued' && x.exemptionId === ex.id)) {
        facts.push({
          type: 'exemptionClosed', at, exemptionId: ex.id, terminal: 'REVOKED',
          reason: 'TEMP_EXCURSION',
        });
      }
    }
  }

  // ---------- 5) 时间驱动：读数过期 -> 证书失效；豁免到期 -> 撤销 ----------
  for (const cert of folded.certificates) {
    if (cert.status !== 'ISSUED') continue;
    if (facts.some((x) => x.type === 'certificateInvalidated' && x.certificateId === cert.id)) continue;
    const latest = latestTemp(folded, cert.reeferId);
    const p = cert.params || precertParams(cargoTier(folded.reefers.get(cert.reeferId)?.cargoGrade));
    if (!latest || at - latest.measuredAt > p.maxReadingAgeMs) {
      facts.push({
        type: 'certificateInvalidated', at, certificateId: cert.id,
        reason: 'STALE_READING',
        restartHint: {
          restartFromAt: at,
          remainingMs: p.requiredStableMs ?? null,
          lastMeasuredAt: latest?.measuredAt ?? null,
          note: '读数已过期：取得新鲜读数后重新观测整个稳定时间窗',
        },
      });
    }
  }
  for (const ex of folded.exemptions) {
    if (ex.status !== 'ACTIVE') continue;
    if (at > ex.validUntil) {
      facts.push({ type: 'exemptionClosed', at, exemptionId: ex.id, terminal: 'REVOKED', reason: 'EXPIRED' });
    }
  }

  return facts;
}

function pcVoyagesOf(s, reeferId) {
  const voyages = new Set();
  for (const c of s.certificates) if (c.reeferId === reeferId) voyages.add(c.voyageId);
  for (const e of s.exemptions) if (e.reeferId === reeferId) voyages.add(e.voyageId);
  for (const o of s.observations) if (o.reeferId === reeferId) voyages.add(o.voyageId);
  return voyages;
}

function invalidateForReefer(facts, s, reeferId, at, reason, restartHint) {
  for (const voyageId of pcVoyagesOf(s, reeferId)) {
    const cert = issuedCert(s, voyageId, reeferId);
    if (cert) facts.push({ type: 'certificateInvalidated', at, certificateId: cert.id, reason, restartHint });
    const ex = activeExemption(s, voyageId, reeferId);
    if (ex) facts.push({ type: 'exemptionClosed', at, exemptionId: ex.id, terminal: 'REVOKED', reason });
  }
}

function supersedeObservation(facts, s, reeferId, at, reason) {
  for (const voyageId of pcVoyagesOf(s, reeferId)) {
    const obs = activeObservation(s, voyageId, reeferId);
    if (obs) facts.push({ type: 'observationSuperseded', at, observationId: obs.id, reason });
  }
}
