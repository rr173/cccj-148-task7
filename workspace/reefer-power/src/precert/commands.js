'use strict';

import {
  bad,
  conflict,
  notFound,
  checkId,
  num,
} from '../util.js';
import {
  pcVersion,
  activeObservation,
  issuedCert,
  activeExemption,
  openHold,
} from '../domain.js';
import { poweredLease } from '../domain.js';
import { cargoTier } from '../peak/risk.js';
import {
  precertParams,
  evaluateObservation,
  certValidity,
  exemptionValidity,
  latestTemp,
} from './evaluate.js';

const OPERATOR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const TEXT_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{P}\p{S}\s]{0,127}$/u;

function actor(body) {
  const id = String(body.operatorId ?? body.actor ?? body.officerId ?? 'OFFICER').trim();
  if (!OPERATOR_RE.test(id)) throw bad('operatorId 非法');
  return id;
}
function text(value, label, { required = true } = {}) {
  if (value == null || value === '') {
    if (required) throw bad(`${label}不能为空`);
    return null;
  }
  const s = String(value).trim();
  if (!TEXT_RE.test(s)) throw bad(`${label}非法`);
  return s;
}

// 版本前置条件：旧页面（expectedVersion 落后）不能覆盖后来产生的失效状态
function checkVersion(s, voyageId, reeferId, expectedVersion) {
  const current = pcVersion(s, voyageId, reeferId);
  if (expectedVersion != null) {
    const ev = Number(expectedVersion);
    if (!Number.isInteger(ev) || ev < 0) throw bad('expectedVersion 必须是非负整数');
    if (ev !== current) {
      throw conflict(`聚合版本已前进：页面基于 ${ev}，当前为 ${current}，请刷新后重试`, {
        code: 'VERSION_STALE',
        currentVersion: current,
        expectedVersion: ev,
      });
    }
  }
  return current;
}

function requireVoyage(s, voyageId) {
  if (!s.pcVoyages.has(voyageId)) throw notFound(`航次未登记: ${voyageId}`);
}
function requireReefer(s, reeferId) {
  const r = s.reefers.get(reeferId);
  if (!r) throw notFound(`冷藏箱不存在: ${reeferId}`);
  return r;
}
function requirePowered(s, reeferId) {
  const lease = poweredLease(s, reeferId);
  if (!lease) {
    throw conflict(`箱 ${reeferId} 当前没有 POWER 供电租约，无法进行预冷观测/放行`, {
      code: 'REEFER_NOT_POWERED',
    });
  }
  return lease;
}

// ---------- 登记航次（合格证绑定航次） ----------
export function cmdVoyageRegister(s, body, at) {
  const voyageId = checkId(body.voyageId, '航次');
  if (s.pcVoyages.has(voyageId)) {
    return { facts: [], reply: { voyageId, registered: false, alreadyRegistered: true } };
  }
  const name = body.name ? text(body.name, '航次名称') : null;
  return {
    facts: [{ type: 'voyageRegistered', at, voyageId, name }],
    reply: { voyageId, registered: true, name },
  };
}

// ---------- 调整设定点（立即失效绑定该箱的证书；高风险也以真实读数重测） ----------
export function cmdSetpoint(s, body, at) {
  const reeferId = checkId(body.reeferId, '冷藏箱');
  const reefer = requireReefer(s, reeferId);
  const setpointC = num(body.setpointC, '设定点温度(℃)', { min: -60, max: 30 });
  if (reefer.setpointC != null && Number(reefer.setpointC) === setpointC) {
    return { facts: [], reply: { adjusted: false, unchanged: true, reeferId, setpointC } };
  }
  const operatorId = actor(body);
  return {
    facts: [{ type: 'setpointAdjusted', at, reeferId, setpointC, operatorId }],
    reply: { adjusted: true, reeferId, previousSetpointC: reefer.setpointC, setpointC },
  };
}

// ---------- 发起/重新发起预冷观测 ----------
export function cmdObserve(s, body, at) {
  const voyageId = checkId(body.voyageId, '航次');
  const reeferId = checkId(body.reeferId, '冷藏箱');
  requireVoyage(s, voyageId);
  requireReefer(s, reeferId);
  const lease = requirePowered(s, reeferId);
  checkVersion(s, voyageId, reeferId, body.expectedVersion);

  const reefer = s.reefers.get(reeferId);
  if (reefer.setpointC == null) {
    throw conflict(`箱 ${reeferId} 尚无设定点，不能开始预冷观测`, { code: 'NO_SETPOINT' });
  }
  const latest = latestTemp(s, reeferId);
  if (!latest) {
    throw conflict(`箱 ${reeferId} 还没有任何已接受的真实温度读数，不能用铭牌估算开始观测`, {
      code: 'NO_TEMPERATURE_READING',
    });
  }
  const sensorBootId = body.sensorBootId != null ? checkId(body.sensorBootId, '传感器启动代号') : latest.sensorBootId;

  // 同一传感器/读数存在时幂等回放（无 commandId 时由内容哈希命中）
  const prev = activeObservation(s, voyageId, reeferId);
  if (prev && prev.sensorBootId === sensorBootId) {
    return {
      facts: [],
      reply: {
        observationId: prev.id,
        started: false,
        alreadyActive: true,
        reeferId,
        voyageId,
        sensorBootId,
        startedAt: prev.startedAt,
        progress: evaluateObservationSafe(s, prev, at),
      },
    };
  }

  const operatorId = actor(body);
  // 编号在归并时确定性分配（与反应事实共享同一序号序列，避免争用）
  const facts = [];
  // 传感器上报过掉电、但租约仍是 POWER 时，值班员在确认恢复后重新观测：
  // 显式补记一条恢复事件，作为连续供电起点（apply 去重）。
  if ((s.powerEvents || []).some((e) => e.reeferId === reeferId && e.kind === 'powerLost')) {
    facts.push({ type: 'powerEventRecorded', at, reeferId, kind: 'powerRestored', reason: 'OBSERVE_CONFIRMED' });
  }
  facts.push({
    type: 'observationStarted',
    at,
    voyageId,
    reeferId,
    sensorBootId,
    startedAt: at,
    operatorId,
    reason: prev ? 'RESTARTED' : 'STARTED',
  });

  return {
    facts,
    enrich: (state2) => {
      const obs = activeObservation(state2, voyageId, reeferId);
      return {
        observationId: obs.id,
        started: true,
        reeferId,
        voyageId,
        sensorBootId,
        startedAt: at,
        socketId: lease.socketId,
        version: pcVersion(state2, voyageId, reeferId),
        progress: evaluateObservationSafe(state2, obs, at),
      };
    },
  };
}

function evaluateObservationSafe(state2, obs, at) {
  const ev = evaluateObservation(state2, obs, at);
  return {
    qualified: ev.qualified,
    reason: ev.reason,
    qualifiedMs: ev.qualifiedMs ?? 0,
    requiredStableMs: ev.requiredStableMs,
    remainingMs: ev.remainingMs ?? ev.requiredStableMs,
    restartFromAt: ev.restartFromAt ?? null,
    evidence: ev.evidence ?? null,
    highRisk: ev.highRisk,
  };
}

// ---------- 签发预冷合格证 ----------
export function cmdCertIssue(s, body, at) {
  const voyageId = checkId(body.voyageId, '航次');
  const reeferId = checkId(body.reeferId, '冷藏箱');
  requireVoyage(s, voyageId);
  const reefer = requireReefer(s, reeferId);
  requirePowered(s, reeferId);
  checkVersion(s, voyageId, reeferId, body.expectedVersion);

  const existing = issuedCert(s, voyageId, reeferId);
  if (existing) {
    throw conflict(`箱 ${reeferId} 在航次 ${voyageId} 已存在有效合格证 ${existing.id}`, {
      code: 'CERT_ACTIVE',
      certificateId: existing.id,
      currentVersion: pcVersion(s, voyageId, reeferId),
    });
  }

  const obs = activeObservation(s, voyageId, reeferId);
  if (!obs) {
    throw conflict(`箱 ${reeferId} 在航次 ${voyageId} 没有进行中的预冷观测，先发起观测`, {
      code: 'NO_OBSERVATION',
    });
  }
  const ev = evaluateObservation(s, obs, at);
  if (!ev.qualified) {
    throw conflict(`观测尚未持续合格，不能签发合格证：${ev.reason}`, {
      code: 'NOT_QUALIFIED',
      progress: {
        reason: ev.reason,
        qualifiedMs: ev.qualifiedMs ?? 0,
        requiredStableMs: ev.requiredStableMs,
        remainingMs: ev.remainingMs ?? ev.requiredStableMs,
        restartFromAt: ev.restartFromAt ?? null,
        evidence: ev.evidence ?? null,
      },
    });
  }

  const tier = cargoTier(reefer.cargoGrade);
  const params = precertParams(tier);
  const operatorId = actor(body);
  const operationId = body.operationId != null
    ? checkId(body.operationId, 'operationId')
    : `cert-${voyageId}-${reeferId}-${at}`;

  const evidence = {
    fromAt: ev.evidence.fromAt,
    toAt: ev.evidence.toAt,
    sampleCount: ev.evidence.sampleCount,
    minC: ev.evidence.minC,
    maxC: ev.evidence.maxC,
    lastValue: ev.evidence.lastValue,
  };
  const fact = {
    type: 'certificateIssued',
    at,
    voyageId,
    reeferId,
    sensorBootId: obs.sensorBootId,
    setpointC: ev.setpointC,
    highRisk: params.highRisk,
    params: {
      requiredStableMs: params.requiredStableMs,
      maxDeviationC: params.maxDeviationC,
      maxReadingAgeMs: params.maxReadingAgeMs,
      maxRateCph: params.maxRateCph,
    },
    evidence,
    observationId: obs.id,
    operatorId,
    operationId,
  };

  return {
    facts: [fact],
    enrich: (state2) => {
      const cert2 = issuedCert(state2, voyageId, reeferId);
      return {
        certificateId: cert2.id,
        issued: true,
        voyageId,
        reeferId,
        sensorBootId: obs.sensorBootId,
        issuedAt: at,
        highRisk: params.highRisk,
        observationId: obs.id,
        evidence,
        version: pcVersion(state2, voyageId, reeferId),
        validity: certValidity(state2, cert2, at),
      };
    },
  };
}

// ---------- 临时豁免 ----------
export function cmdExemption(s, body, at) {
  const voyageId = checkId(body.voyageId, '航次');
  const reeferId = checkId(body.reeferId, '冷藏箱');
  requireVoyage(s, voyageId);
  requireReefer(s, reeferId);
  checkVersion(s, voyageId, reeferId, body.expectedVersion);

  const reason = text(body.reason, '豁免原因');
  const cargoOwner = text(body.cargoOwner, '货物负责人身份');
  const ttlMin = num(body.ttlMinutes ?? body.durationMinutes ?? 60, '豁免有效期(分钟)', { min: 1, max: 1440 });
  const operatorId = actor(body);

  const existingCert = issuedCert(s, voyageId, reeferId);
  if (existingCert) {
    throw conflict(`箱 ${reeferId} 已持有有效合格证 ${existingCert.id}，无需豁免`, {
      code: 'CERT_ACTIVE',
      certificateId: existingCert.id,
    });
  }
  const existing = activeExemption(s, voyageId, reeferId);
  if (existing) {
    throw conflict(`箱 ${reeferId} 在航次 ${voyageId} 已存在有效豁免 ${existing.id}`, {
      code: 'EXEMPTION_ACTIVE',
      exemptionId: existing.id,
      validUntil: existing.validUntil,
    });
  }

  const reefer = requireReefer(s, reeferId);
  const tier = cargoTier(reefer.cargoGrade);
  const validUntil = at + Math.round(ttlMin * 60000);
  const operationId = body.operationId != null
    ? checkId(body.operationId, 'operationId')
    : `exempt-${voyageId}-${reeferId}-${at}`;

  return {
    facts: [{
      type: 'exemptionIssued',
      at,
      voyageId,
      reeferId,
      reason,
      cargoOwner,
      validUntil,
      operatorId,
      operationId,
      highRisk: tier >= 3,
    }],
    enrich: (state2) => {
      const ex2 = activeExemption(state2, voyageId, reeferId);
      return {
        exemptionId: ex2.id,
        issued: true,
        voyageId,
        reeferId,
        reason,
        cargoOwner,
        issuedAt: at,
        validUntil,
        ttlMinutes: ttlMin,
        secondsRemaining: Math.round((validUntil - at) / 1000),
        version: pcVersion(state2, voyageId, reeferId),
      };
    },
  };
}

// ---------- 岸桥扫描 / 装船确认：查询当前合格证，决定放行或进待处理 ----------
export function cmdLoadingScan(s, body, at) {
  const voyageId = checkId(body.voyageId, '航次');
  const reeferId = checkId(body.reeferId, '冷藏箱');
  requireVoyage(s, voyageId);
  requireReefer(s, reeferId);
  const slotCode = body.slotCode != null ? checkId(String(body.slotCode), '槽位号') : null;
  const scannerId = body.scannerId != null ? checkId(String(body.scannerId), '扫描终端') : null;

  // 已有 OPEN 待处理：回放同一判定（幂等），原装船计划/插座事实不变
  const existingHold = openHold(s, voyageId, reeferId);

  const cert = issuedCert(s, voyageId, reeferId);
  const certCheck = cert ? certValidity(s, cert, at) : { valid: false, reason: 'NO_CERTIFICATE' };
  const ex = activeExemption(s, voyageId, reeferId);
  const exCheck = ex ? exemptionValidity(ex, at) : { valid: false, reason: 'NO_EXEMPTION' };

  // 放行依据：优先有效合格证，其次有效豁免
  let basis = null;
  if (certCheck.valid) {
    basis = { kind: 'CERTIFICATE', id: cert.id, sensorBootId: cert.sensorBootId, highRisk: cert.highRisk, evidence: cert.evidence };
  } else if (exCheck.valid) {
    basis = { kind: 'EXEMPTION', id: ex.id, reason: ex.reason, cargoOwner: ex.cargoOwner, validUntil: ex.validUntil };
  }

  const facts = [];

  if (basis) {
    if (existingHold) {
      facts.push({
        type: 'loadingHoldRecorded',
        at, event: 'resolved', holdId: existingHold.id,
        resolution: 'RELEASED', releaseId: `REL-${existingHold.id}`, basis,
      });
    }
    return {
      facts,
      reply: {
        outcome: 'RELEASED',
        voyageId,
        reeferId,
        slotCode,
        basis,
        releasedAt: at,
        pendingQueueSize: s.loadingHolds.filter((h) => h.state === 'OPEN').length,
      },
    };
  }

  // 无有效合格证/豁免 -> 进入温控待处理队列（计划与插座事实保持不变）
  const reasons = [];
  if (cert) reasons.push({ certificateId: cert.id, invalid: true, reason: certCheck.reason });
  if (ex) reasons.push({ exemptionId: ex.id, invalid: true, reason: exCheck.reason });
  const blockReason = cert ? certCheck.reason : ex ? exCheck.reason : 'NO_CERTIFICATE';

  if (!existingHold) {
    facts.push({
      type: 'loadingHoldRecorded',
      at, event: 'opened', voyageId, reeferId,
      slotCode, scannerId, reason: blockReason,
    });
  }

  return {
    facts,
    enrich: (state2) => {
      const h2 = openHold(state2, voyageId, reeferId);
      return {
        outcome: 'HELD',
        voyageId,
        reeferId,
        slotCode,
        holdId: h2.id,
        duplicate: !!existingHold,
        reason: blockReason,
        evaluated: reasons,
        pendingQueueSize: state2.loadingHolds.filter((h) => h.state === 'OPEN').length,
        note: '原装船计划与插座事实保持不变；恢复供电/取得合格证后重新扫描即放行',
      };
    },
  };
}
