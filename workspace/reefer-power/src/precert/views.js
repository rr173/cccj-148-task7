'use strict';

import {
  activeObservation,
  issuedCert,
  activeExemption,
  openHold,
  pcVersion,
  poweredLease,
} from '../domain.js';
import { cargoTier } from '../peak/risk.js';
import {
  precertParams,
  evaluateObservation,
  certValidity,
  exemptionValidity,
  latestTemp,
} from './evaluate.js';

function certView(s, c, at) {
  const validity = certValidity(s, c, at);
  return {
    id: c.id,
    version: c.version,
    voyageId: c.voyageId,
    reeferId: c.reeferId,
    sensorBootId: c.sensorBootId,
    setpointC: c.setpointC,
    issuedAt: c.issuedAt,
    status: c.status,
    highRisk: c.highRisk,
    valid: validity.valid,
    invalidReason: validity.valid ? null : (c.invalidateReason || validity.reason),
    invalidateReason: validity.valid ? null : (c.invalidateReason || validity.reason),
    invalidateCode: c.invalidateReason || null,
    invalidatedAt: c.invalidatedAt,
    restartHint: c.restartHint,
    evidence: c.evidence,
    observationId: c.observationId,
    operatorId: c.operatorId,
    operationId: c.operationId,
  };
}

function exemptionView(e, at) {
  const validity = exemptionValidity(e, at);
  return {
    id: e.id,
    version: e.version,
    voyageId: e.voyageId,
    reeferId: e.reeferId,
    reason: e.reason,
    cargoOwner: e.cargoOwner,
    issuedAt: e.issuedAt,
    validUntil: e.validUntil,
    status: e.status,
    highRisk: e.highRisk,
    valid: validity.valid,
    revokeReason: validity.valid ? null : (e.revokeReason || validity.reason),
    revokedAt: e.revokedAt,
    closedAt: e.closedAt,
    closedByCertId: e.closedByCertId,
    secondsRemaining: e.status === 'ACTIVE' ? Math.max(0, Math.round((e.validUntil - at) / 1000)) : 0,
    operatorId: e.operatorId,
    operationId: e.operationId,
  };
}

function holdView(h, at, s) {
  const cert = issuedCert(s, h.voyageId, h.reeferId);
  const ex = activeExemption(s, h.voyageId, h.reeferId);
  const certOk = cert && certValidity(s, cert, at).valid;
  const exOk = ex && exemptionValidity(ex, at).valid;
  return {
    id: h.id,
    voyageId: h.voyageId,
    reeferId: h.reeferId,
    openedAt: h.openedAt,
    ageMs: at - h.openedAt,
    slotCode: h.slotCode,
    scannerId: h.scannerId,
    reason: h.reason,
    state: h.state,
    resolvedAt: h.resolvedAt,
    resolution: h.resolution,
    releaseId: h.releaseId,
    basis: h.basis,
    releasableNow: h.state === 'OPEN' && !!(certOk || exOk),
  };
}

// 单箱在某航次下的完整预冷/放行画像（合格进度、证据、失效、豁免倒计时、放行结论）
export function precertForReefer(s, voyageId, reeferId, at) {
  const reefer = s.reefers.get(reeferId);
  if (!reefer) return null;
  const tier = cargoTier(reefer.cargoGrade);
  const params = precertParams(tier);
  const lease = poweredLease(s, reeferId);
  const latest = latestTemp(s, reeferId);
  const obs = activeObservation(s, voyageId, reeferId);
  const progress = obs ? evaluateObservation(s, obs, at) : null;
  const cert = [...s.certificates]
    .filter((c) => c.voyageId === voyageId && c.reeferId === reeferId)
    .sort((a, b) => b.issuedAt - a.issuedAt)[0] || null;
  const ex = [...s.exemptions]
    .filter((e) => e.voyageId === voyageId && e.reeferId === reeferId)
    .sort((a, b) => b.issuedAt - a.issuedAt)[0] || null;
  const hold = openHold(s, voyageId, reeferId);

  const certValid = cert ? certValidity(s, cert, at) : { valid: false, reason: 'NO_CERTIFICATE' };
  const exValid = ex ? exemptionValidity(ex, at) : { valid: false, reason: 'NO_EXEMPTION' };
  const release = certValid.valid
    ? { allowed: true, basis: 'CERTIFICATE', basisId: cert.id }
    : exValid.valid
      ? { allowed: true, basis: 'EXEMPTION', basisId: ex.id, secondsRemaining: Math.max(0, Math.round((ex.validUntil - at) / 1000)) }
      : { allowed: false, reason: cert ? certValid.reason : ex ? exValid.reason : 'NO_CERTIFICATE' };

  return {
    voyageId,
    reeferId,
    cargoGrade: reefer.cargoGrade,
    tier,
    highRisk: params.highRisk,
    setpointC: reefer.setpointC,
    socketId: lease?.socketId ?? null,
    powered: !!lease,
    params: {
      requiredStableMs: params.requiredStableMs,
      maxDeviationC: params.maxDeviationC,
      maxReadingAgeMs: params.maxReadingAgeMs,
      maxRateCph: params.maxRateCph,
    },
    lastTemperature: latest
      ? { value: latest.value, measuredAt: latest.measuredAt, sensorBootId: latest.sensorBootId, ageMs: at - latest.measuredAt, fresh: at - latest.measuredAt <= params.maxReadingAgeMs }
      : null,
    version: pcVersion(s, voyageId, reeferId),
    observation: obs
      ? {
          id: obs.id,
          sensorBootId: obs.sensorBootId,
          startedAt: obs.startedAt,
          qualified: progress?.qualified ?? false,
          reason: progress?.reason ?? null,
          qualifiedMs: progress?.qualifiedMs ?? 0,
          remainingMs: progress?.remainingMs ?? params.requiredStableMs,
          percent: Math.min(100, Math.round(((progress?.qualifiedMs ?? 0) / params.requiredStableMs) * 100)),
          restartFromAt: progress?.restartFromAt ?? null,
          evidence: progress?.evidence ?? null,
        }
      : null,
    certificate: cert ? certView(s, cert, at) : null,
    exemption: ex ? exemptionView(ex, at) : null,
    hold: hold ? holdView(hold, at, s) : null,
    release,
  };
}

export function buildPrecertView(s, at) {
  const voyages = [...s.pcVoyages];
  const perVoyage = voyages.map((voyageId) => {
    // 该航次涉及的箱：观测/证书/豁免/待处理 中出现过的，并集上当前已接电箱（可选）
    const reeferIds = new Set();
    for (const o of s.observations) if (o.voyageId === voyageId) reeferIds.add(o.reeferId);
    for (const c of s.certificates) if (c.voyageId === voyageId) reeferIds.add(c.reeferId);
    for (const e of s.exemptions) if (e.voyageId === voyageId) reeferIds.add(e.reeferId);
    for (const h of s.loadingHolds) if (h.voyageId === voyageId) reeferIds.add(h.reeferId);
    const reefers = [...reeferIds]
      .map((rid) => precertForReefer(s, voyageId, rid, at))
      .filter(Boolean)
      .sort((a, b) => a.reeferId.localeCompare(b.reeferId));

    return {
      voyageId,
      reefers,
      counts: {
        total: reefers.length,
        certified: reefers.filter((r) => r.release.allowed && r.release.basis === 'CERTIFICATE').length,
        exempted: reefers.filter((r) => r.release.allowed && r.release.basis === 'EXEMPTION').length,
        observing: reefers.filter((r) => r.observation && !r.certificate?.valid).length,
        blocked: reefers.filter((r) => !r.release.allowed).length,
        openHolds: reefers.filter((r) => r.hold && r.hold.state === 'OPEN').length,
      },
      openHolds: s.loadingHolds
        .filter((h) => h.voyageId === voyageId && h.state === 'OPEN')
        .map((h) => holdView(h, at, s))
        .sort((a, b) => a.openedAt - b.openedAt),
    };
  });

  return {
    at,
    voyages: perVoyage,
    certificates: [...s.certificates].map((c) => certView(s, c, at)).sort((a, b) => b.issuedAt - a.issuedAt),
    exemptions: [...s.exemptions].map((e) => exemptionView(e, at)).sort((a, b) => b.issuedAt - a.issuedAt),
    openHolds: s.loadingHolds
      .filter((h) => h.state === 'OPEN')
      .map((h) => holdView(h, at, s))
      .sort((a, b) => a.openedAt - b.openedAt),
    holds: [...s.loadingHolds].map((h) => holdView(h, at, s)).sort((a, b) => b.openedAt - a.openedAt),
  };
}
