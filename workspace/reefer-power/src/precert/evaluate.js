'use strict';

import { round2 } from '../util.js';
import { cargoTier } from '../peak/risk.js';

// 预冷合格证的合格判据。高风险货物（PHARMA/HIGH）使用更严格的稳定时间、
// 温度偏差、读数新鲜度与变化速度阈值；阈值可用环境变量整体覆盖（演练/测试）。

const MIN = 60 * 1000;

function envInt(key, dflt) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
function envNum(key, dflt) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export function precertParams(tier) {
  const high = tier >= 3;
  return {
    tier,
    highRisk: high,
    // 观测时间窗内必须持续合格的最短稳定时间
    requiredStableMs: high
      ? envInt('REEFER_PC_HIGH_STABLE_MS', 30 * MIN)
      : envInt('REEFER_PC_STABLE_MS', 15 * MIN),
    // 箱温相对设定点允许的最大偏差（℃，绝对值）
    maxDeviationC: high
      ? envNum('REEFER_PC_HIGH_DEVIATION_C', 0.5)
      : envNum('REEFER_PC_DEVIATION_C', 1.5),
    // 最新读数相对当前时刻允许的最大陈旧度
    maxReadingAgeMs: high
      ? envInt('REEFER_PC_HIGH_FRESH_MS', 3 * MIN)
      : envInt('REEFER_PC_FRESH_MS', 5 * MIN),
    // 相邻读数间允许的最大温度变化速度（℃/h）
    maxRateCph: high
      ? envNum('REEFER_PC_HIGH_RATE_CPH', 2)
      : envNum('REEFER_PC_RATE_CPH', 4),
  };
}

// 取该箱按测量时刻升序、已接受的真实温度读数（隔离样本不参与；绝不回退铭牌）。
// 只取给定传感器启动代号（若提供），保证观测期间传感器未被更换。
export function tempReadings(s, reeferId, sensorBootId = null) {
  const out = [];
  for (const smp of s.samples.values()) {
    if (!smp.accepted || smp.kind !== 'temperature' || smp.reeferId !== reeferId) continue;
    if (sensorBootId && smp.sensorBootId !== sensorBootId) continue;
    out.push({ measuredAt: smp.measuredAt, value: smp.value, sensorBootId: smp.sensorBootId });
  }
  return out.sort((a, b) => a.measuredAt - b.measuredAt);
}

// 该箱当前最新（总体，不限 boot）的真实温度读数
export function latestTemp(s, reeferId) {
  const all = tempReadings(s, reeferId);
  return all.length ? all[all.length - 1] : null;
}

// 该箱供电连续性事件（powerLost / powerRestored，按时间）
export function powerEvents(s, reeferId) {
  return (s.powerEvents || [])
    .filter((e) => e.reeferId === reeferId)
    .sort((a, b) => a.at - b.at);
}

// 最近一次恢复供电时刻；null 表示没有掉电记录（以当前 POWER 租约起始为供电起点）
export function lastPowerRestore(s, reeferId) {
  const evs = powerEvents(s, reeferId);
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].kind === 'powerRestored') return evs[i].at;
  }
  // 没有显式恢复事件但存在掉电：仍处于掉电中（或由传感器上报尚未确认恢复）
  if (evs.some((e) => e.kind === 'powerLost')) return null;
  return null;
}

// 自何时起持续供电（没有发生过掉电）。无掉电历史时返回 0（自古以来）。
export function poweredContinuouslySince(s, reeferId) {
  const evs = powerEvents(s, reeferId);
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].kind === 'powerRestored') return evs[i].at;
    if (evs[i].kind === 'powerLost') return null; // 最近事件是掉电
  }
  return 0;
}

function unmet(reason, extra = {}) {
  return { qualified: false, reason, ...extra };
}

// 评估一个观测在 at 时刻是否已“持续合格”达到稳定时间窗（确定性纯函数）。
// 同时返回合格进度、证据区间与“从何时起、还差多久”的提示，供页面/接口展示。
//
// obs: {id, voyageId, reeferId, sensorBootId, startedAt, state}
export function evaluateObservation(s, obs, at) {
  const reefer = s.reefers.get(obs.reeferId);
  if (!reefer) return unmet('REEFER_UNKNOWN');
  if (obs.state !== 'ACTIVE') return unmet('OBSERVATION_SUPERSEDED');
  const tier = cargoTier(reefer.cargoGrade);
  const p = precertParams(tier);
  const setpoint = reefer.setpointC != null ? Number(reefer.setpointC) : null;

  const base = {
    observationId: obs.id,
    voyageId: obs.voyageId,
    reeferId: obs.reeferId,
    highRisk: p.highRisk,
    tier,
    sensorBootId: obs.sensorBootId,
    setpointC: setpoint,
    startedAt: obs.startedAt,
    requiredStableMs: p.requiredStableMs,
    maxDeviationC: p.maxDeviationC,
    maxReadingAgeMs: p.maxReadingAgeMs,
    maxRateCph: p.maxRateCph,
  };

  if (setpoint == null) return { ...base, ...unmet('NO_SETPOINT') };

  // 1) 供电连续性：观测起点以来不得掉电，且当前必须处于 POWER 租约
  const poweredLease = (s.leases || []).find(
    (l) => l.reeferId === obs.reeferId && l.state === 'POWER'
  );
  if (!poweredLease) return { ...base, ...unmet('NOT_POWERED') };
  const contSince = poweredContinuouslySince(s, obs.reeferId);
  if (contSince == null) {
    return {
      ...base,
      ...unmet('POWER_LOSS', {
        restartFromAt: at,
        note: '当前处于掉电：恢复供电后由值班员重新发起观测',
      }),
    };
  }
  // 观测起点必须不早于连续供电起点（观测窗口内不能跨过掉电）
  const powerFloor = Math.max(obs.startedAt, contSince);

  // 2) 设定点在观测起点后不得调整（调整会新建事实并把观测/证书作废，
  //    这里再以 reefers 上记录的最近设定点变更时刻兜底）
  const setpointChangedAt = reefer.setpointChangedAt ?? null;
  if (setpointChangedAt != null && setpointChangedAt > obs.startedAt) {
    return {
      ...base,
      ...unmet('SETPOINT_CHANGED', {
        restartFromAt: setpointChangedAt,
        remainingMs: p.requiredStableMs,
      }),
    };
  }

  // 3) 真实温度读数（绑定观测的传感器启动代号），绝不回退铭牌估算
  const readings = tempReadings(s, obs.reeferId, obs.sensorBootId);
  if (!readings.length) {
    return {
      ...base,
      ...unmet('NO_TEMPERATURE_READING', {
        restartFromAt: powerFloor,
        note: '尚无绑定该传感器启动代号的真实温度读数',
      }),
    };
  }
  const latest = readings[readings.length - 1];

  // 传感器更换：当前最新读数的 boot 与观测绑的 boot 不同 -> 必须重新观测
  const overall = latestTemp(s, obs.reeferId);
  if (overall && overall.sensorBootId !== obs.sensorBootId) {
    const replacedAt = overall.measuredAt;
    return {
      ...base,
      ...unmet('SENSOR_REPLACED', {
        currentSensorBootId: overall.sensorBootId,
        restartFromAt: replacedAt,
        remainingMs: p.requiredStableMs,
      }),
    };
  }

  // 4) 最新读数新鲜度（过期读数不能放行）
  const ageMs = at - latest.measuredAt;
  if (ageMs > p.maxReadingAgeMs) {
    return {
      ...base,
      ...unmet('STALE_READING', {
        lastMeasuredAt: latest.measuredAt,
        ageMs,
        restartFromAt: at,
        note: '读数已过期：取得新读数后重新计时',
      }),
    };
  }

  // 5) 从最新读数向前回溯，找出“持续合格”的最长后缀窗口 [windowStart, latest]。
  //    逐点检查偏差与相邻变化速度；任一不合格即截断到该点之后。
  let windowStart = latest.measuredAt;
  let firstBadAt = null;
  let firstBadReason = null;
  for (let i = readings.length - 1; i >= 0; i--) {
    const r = readings[i];
    const dev = Math.abs(r.value - setpoint);
    if (dev > p.maxDeviationC + 1e-9) {
      firstBadAt = r.measuredAt;
      firstBadReason = 'DEVIATION_EXCEEDED';
      break;
    }
    if (i > 0) {
      const prev = readings[i - 1];
      const dtH = (r.measuredAt - prev.measuredAt) / 3600000;
      if (dtH > 0) {
        const rate = Math.abs((r.value - prev.value) / dtH);
        if (rate > p.maxRateCph + 1e-9) {
          firstBadAt = prev.measuredAt;
          firstBadReason = 'RATE_EXCEEDED';
          break;
        }
      }
    }
    windowStart = r.measuredAt;
  }

  // 合格后缀还必须落在观测起点与连续供电起点之后
  windowStart = Math.max(windowStart, powerFloor);
  const evidence = readings.filter(
    (r) => r.measuredAt >= windowStart && r.measuredAt <= latest.measuredAt
  );

  // 合格持续时长：以“合格后缀起点 → 当前时刻”计。读数可以稍旧（仍在新鲜窗内），
  // 说明设备自合格后缀起点起持续合格；但窗口起点必须早到足以覆盖整个稳定时间。
  const qualifiedMs = Math.max(0, at - windowStart);
  const ready = qualifiedMs >= p.requiredStableMs && evidence.length >= 2;

  const summary = {
    fromAt: windowStart,
    toAt: latest.measuredAt,
    sampleCount: evidence.length,
    firstValue: evidence.length ? evidence[0].value : null,
    lastValue: latest.value,
    minC: evidence.length ? Math.min(...evidence.map((e) => e.value)) : null,
    maxC: evidence.length ? Math.max(...evidence.map((e) => e.value)) : null,
  };

  if (!ready) {
    let reason = 'STABILIZING';
    let restartFromAt = windowStart;
    let note = null;
    if (firstBadAt != null) {
      reason = firstBadReason;
      restartFromAt = firstBadAt;
    } else if (evidence.length < 2) {
      reason = 'INSUFFICIENT_SAMPLES';
    }
    return {
      ...base,
      ...unmet(reason, {
        qualifiedMs,
        remainingMs: Math.max(0, p.requiredStableMs - qualifiedMs),
        restartFromAt,
        lastMeasuredAt: latest.measuredAt,
        ageMs,
        evidence: summary,
        firstBadAt,
        note,
      }),
    };
  }

  return {
    ...base,
    qualified: true,
    reason: null,
    qualifiedMs,
    remainingMs: 0,
    lastMeasuredAt: latest.measuredAt,
    ageMs,
    currentC: round2(latest.value),
    excursionC: round2(latest.value - setpoint),
    restartFromAt: null,
    evidence: summary,
  };
}

// 证书/豁免在 at 时刻是否仍“有效”（可放行）。除状态外还要检查时间与最新读数新鲜度。
// 已失效（status=INVALID）的证书永远不会再变回有效——这里不再做复活判断。
export function certValidity(s, cert, at) {
  if (cert.status !== 'ISSUED') return { valid: false, reason: cert.invalidateReason || 'INVALID' };
  const reefer = s.reefers.get(cert.reeferId);
  if (!reefer) return { valid: false, reason: 'REEFER_UNKNOWN' };
  const tier = cargoTier(reefer.cargoGrade);
  const p = precertParams(tier);
  const latest = latestTemp(s, cert.reeferId);
  if (!latest) return { valid: false, reason: 'NO_TEMPERATURE_READING' };
  const age = at - latest.measuredAt;
  if (age > p.maxReadingAgeMs) return { valid: false, reason: 'STALE_READING', ageMs: age };
  if (latest.sensorBootId !== cert.sensorBootId) {
    return { valid: false, reason: 'SENSOR_REPLACED', currentSensorBootId: latest.sensorBootId };
  }
  // 供电连续性：签发后发生掉电（reactor 通常已把它置 INVALID，这里兜底）
  const contSince = poweredContinuouslySince(s, cert.reeferId);
  if (contSince == null || contSince > cert.issuedAt) {
    return { valid: false, reason: 'POWER_LOSS' };
  }
  return { valid: true };
}

export function exemptionValidity(ex, at) {
  if (ex.status !== 'ACTIVE') return { valid: false, reason: ex.revokeReason || 'CLOSED' };
  if (at > ex.validUntil) return { valid: false, reason: 'EXPIRED' };
  return { valid: true };
}
