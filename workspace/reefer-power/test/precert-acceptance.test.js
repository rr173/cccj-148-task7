'use strict';

import { test } from 'node:test';
import {
  newDataDir,
  startServer,
  stopServer,
  restart,
  post,
  api,
  assert,
  assertEq,
} from './helpers.js';

// 预冷合格证与放行互锁：端到端验收。
// 用虚拟时钟驱动，温度样本按 4 分钟节奏上报（默认低风险稳定窗 15 分钟、新鲜窗 5 分钟；
// 高风险稳定窗 30 分钟、偏差 0.5℃）。

async function clock(proc) {
  return (await api(proc, 'GET', '/test/clock')).json.now;
}
async function advance(proc, ms) {
  await api(proc, 'POST', '/test/clock/advance', { ms });
}
async function temp(proc, reeferId, sensorBootId, value, at) {
  const v = value == null ? -18 : value;
  return post(proc, '/api/samples', { kind: 'temperature', reeferId, sensorBootId, measuredAt: at, value: v });
}
async function tempAt(proc, reeferId, boot, def, val, at) {
  return post(proc, '/api/samples', { kind: 'temperature', reeferId, sensorBootId: boot, measuredAt: at, value: val == null ? def : val });
}
const TOPO = {
  boards: [{ id: 'B1', name: '主配电板' }],
  circuits: [{ id: 'C1', boardId: 'B1', name: '回路1', phase: '3P', ratedCurrentA: 63 }],
  sockets: [
    { id: 'S1', circuitId: 'C1', allowedBoxTypes: ['A1'], reachAreas: ['BAY-A'] },
    { id: 'S2', circuitId: 'C1', allowedBoxTypes: ['A1'], reachAreas: ['BAY-A'] },
  ],
};

function reefer(id, { grade = 'FROZEN', setpoint = -18, rise = 5 } = {}) {
  return {
    id, boxType: 'A1', phase: '3P', powerKw: 5, area: 'BAY-A',
    tempPriority: 3, insulationHours: 8,
    cargoGrade: grade, setpointC: setpoint, allowableRiseC: rise,
  };
}

// 建一套：拓扑 + 接电箱 + 航次；返回每个箱的插座
async function seed(proc, reefers, voyageId = 'V1') {
  await post(proc, '/api/topology', TOPO);
  await post(proc, '/api/reefers', { reefers });
  const res = await post(proc, '/api/reservations', {});
  const sockets = {};
  for (const r of res.json.reserved) sockets[r.reeferId] = r.socketId;
  for (const id of Object.keys(sockets)) await post(proc, '/api/connect', { reeferId: id, socketId: sockets[id] });
  await post(proc, '/api/precert/voyages', { voyageId });
  return sockets;
}

// 上报两个起始读数并发起观测
async function startObservation(proc, voyageId, reeferId, boot, expectedVersion, stepMs = 240000) {
  let t = await clock(proc);
  await temp(proc, reeferId, boot, null, t);
  await advance(proc, stepMs);
  t = await clock(proc);
  await temp(proc, reeferId, boot, null, t);
  const body = { voyageId, reeferId, sensorBootId: boot };
  if (expectedVersion !== undefined && expectedVersion !== null) body.expectedVersion = expectedVersion;
  return post(proc, '/api/precert/observe', body);
}

// 每次推进 stepMs 并补一条读数，直到观测判定 qualified（最多 20 次）
async function tickQualify(proc, voyageId, reeferId, boot, value = null, stepMs = 240000) {
  for (let i = 0; i < 20; i++) {
    const v = await pcView(proc, voyageId, reeferId);
    if (v.observation?.qualified) return v;
    await advance(proc, stepMs);
    const t = await clock(proc);
    await temp(proc, reeferId, boot, value, t);
  }
  return pcView(proc, voyageId, reeferId);
}

async function pcView(proc, voyageId, reeferId) {
  return (await api(proc, 'GET', `/api/precert/reefer?voyageId=${voyageId}&reeferId=${reeferId}`)).json;
}
async function stateCert(proc, voyageId, reeferId) {
  const v = await pcView(proc, voyageId, reeferId);
  return v.certificate;
}

// ---------------------------------------------------------------
test('PC1. 稳定温度持续合格后签发绑定箱号/航次/传感器/证据区间的合格证并放行', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    const obs = await startObservation(proc, 'V1', 'R1', 'BOOT1', 0);
    assertEq(obs.json.version, 1, '观测建立聚合版本 1');
    assertEq(obs.json.progress.qualified, false, '观测刚开始尚未合格');
    assert(obs.json.progress.remainingMs > 14 * 60000, '低风险需稳定约 15 分钟');

    // 未到稳定时间：不签发，并明确剩余时长
    const early = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'R1', expectedVersion: 1 }, { expectStatus: 409 });
    assertEq(early.json.error.code, 'NOT_QUALIFIED', '未稳定不签发');
    assert(early.json.error.progress.remainingMs > 0, '返回剩余时长');

    await tickQualify(proc, 'V1', 'R1', 'BOOT1');
    const issue = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'R1', expectedVersion: 1, operationId: 'OP-1' });
    assert(issue.json.certificateId, '已签发合格证');
    assertEq(issue.json.validity.valid, true, '合格证有效');

    const cert = await stateCert(proc, 'V1', 'R1');
    assertEq(cert.reeferId, 'R1', '绑定箱号');
    assertEq(cert.voyageId, 'V1', '绑定航次');
    assertEq(cert.sensorBootId, 'BOOT1', '绑定传感器启动代号');
    assertEq(cert.operationId, 'OP-1', '绑定 operationId');
    assert(cert.evidence.fromAt && cert.evidence.toAt >= cert.evidence.fromAt, '含证据区间摘要');
    assert(cert.evidence.sampleCount >= 2, '证据区间含多个读数');

    // 装船/岸桥扫描查询当前合格证 -> 放行
    const scan = await post(proc, '/api/precert/scan',
      { voyageId: 'V1', reeferId: 'R1', slotCode: '02-01-82', scannerId: 'HH1' });
    assertEq(scan.json.outcome, 'RELEASED', '有效证书放行');
    assertEq(scan.json.basis.kind, 'CERTIFICATE', '放行依据为合格证');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC2. 读数过期不能签发；签发后读数过期则证书立即失效', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    await startObservation(proc, 'V1', 'R1', 'BOOT1', 0);
    await tickQualify(proc, 'V1', 'R1', 'BOOT1');
    // 不再补读数，推进超过新鲜窗 5 分钟
    await advance(proc, 6 * 60000);
    const blocked = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', 'reeferId': 'R1', expectedVersion: 1 }, { expectStatus: 409 });
    assertEq(blocked.json.error.code, 'NOT_QUALIFIED', '过期读数不签发');
    assertEq(blocked.json.error.progress.reason, 'STALE_READING', '原因为读数过期');

    // 补新鲜读数并从当前时刻重新覆盖整个稳定窗（旧读数已过期，合格后缀从新读数起算）
    let t = await clock(proc);
    await temp(proc, 'R1', 'BOOT1', null, t);
    await tickQualify(proc, 'V1', 'R1', 'BOOT1');
    const issue = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'R1', expectedVersion: 1 });
    assert(issue.json.certificateId, '恢复新鲜并稳定后签发');

    // 签发后读数过期 -> 自动失效，扫描拦截
    await advance(proc, 6 * 60000);
    const cert = await stateCert(proc, 'V1', 'R1');
    assertEq(cert.status, 'INVALID', '过期使证书失效');
    assertEq(cert.invalidateReason, 'STALE_READING', '失效原因为读数过期');
    assert(cert.restartHint.restartFromAt, '给出重新观测起点');
    assert(cert.restartHint.remainingMs >= 15 * 60000 - 1000, '给出剩余稳定时长');
    const scan = await post(proc, '/api/precert/scan',
      { voyageId: 'V1', reeferId: 'R1' }, { expectStatus: 200 });
    assertEq(scan.json.outcome, 'HELD', '失效证书不予放行');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC3. 观测中途掉电：旧观测作废，恢复供电后必须重新计时整个稳定窗', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    const obs = await startObservation(proc, 'V1', 'R1', 'BOOT1', 0);
    // 稳定到一半
    await advance(proc, 240000);
    let t = await clock(proc);
    await temp(proc, 'R1', 'BOOT1', null, t);
    await advance(proc, 240000);
    t = await clock(proc);
    await temp(proc, 'R1', 'BOOT1', null, t);

    // 回路跳闸：观测立即作废
    await post(proc, '/api/circuits/trip', { circuitId: 'C1' });
    let v = await pcView(proc, 'V1', 'R1');
    assertEq(v.observation, null, '掉电后活动观测被作废');
    assertEq(v.powered, false, '箱处于掉电');

    // 复位恢复供电，值班员重新发起观测
    await post(proc, '/api/circuits/reset', { circuitId: 'C1' });
    const reobs = await post(proc, '/api/precert/observe',
      { voyageId: 'V1', reeferId: 'R1', sensorBootId: 'BOOT1' });
    assert(reobs.json.observationId, '重新观测已发起');
    assert(reobs.json.observationId !== obs.json.observationId, '产生新的观测区间');

    // 恢复后未达整个窗：不能签发（即使掉电前已累计 8 分钟）
    await advance(proc, 8 * 60000);
    t = await clock(proc);
    await temp(proc, 'R1', 'BOOT1', null, t);
    const early = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'R1' }, { expectStatus: 409 });
    assertEq(early.json.error.code, 'NOT_QUALIFIED', '掉电后重新计时，未满窗不签发');

    await tickQualify(proc, 'V1', 'R1', 'BOOT1');
    const issue = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'R1' });
    assert(issue.json.certificateId, '重新观测满窗后签发');
    const cert = await stateCert(proc, 'V1', 'R1');
    assert(cert.evidence.fromAt >= reobs.json.startedAt - 1000, '证据区间始于重新观测之后');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC4. 传感器更换使旧证书立即失效；以新传感器重新观测后仅一张有效证书', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    await startObservation(proc, 'V1', 'R1', 'BOOT1', 0);
    await tickQualify(proc, 'V1', 'R1', 'BOOT1');
    const issue = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'R1', expectedVersion: 1 });
    const oldId = issue.json.certificateId;

    // 新传感器启动代号上报读数 -> 旧证书失效
    const t = await clock(proc);
    await temp(proc, 'R1', 'BOOT2', null, t);
    const cert = await stateCert(proc, 'V1', 'R1');
    assertEq(cert.status, 'INVALID', '旧证书失效');
    assertEq(cert.invalidateReason, 'SENSOR_REPLACED', '原因：传感器更换');
    assertEq(cert.restartHint.currentSensorBootId, 'BOOT2', '提示新传感器代号');

    const scan = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan.json.outcome, 'HELD', '失效后扫描进待处理');

    // 以新传感器重新观测满窗
    await post(proc, '/api/precert/observe', { voyageId: 'V1', reeferId: 'R1', sensorBootId: 'BOOT2' });
    await tickQualify(proc, 'V1', 'R1', 'BOOT2');
    const issue2 = await post(proc, '/api/precert/certificates', { voyageId: 'V1', reeferId: 'R1' });
    assert(issue2.json.certificateId !== oldId, '签发新合格证');
    const st = (await api(proc, 'GET', '/api/precert/state')).json;
    const issued = st.certificates.filter((c) => c.reeferId === 'R1' && c.status === 'ISSUED');
    assertEq(issued.length, 1, '同一观测/箱最终只有一张有效证书');
    const scan2 = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan2.json.outcome, 'RELEASED', '新证书放行');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC5. 无证扫描进入温控待处理队列，原装船计划与插座事实不变', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    const scan1 = await post(proc, '/api/precert/scan',
      { voyageId: 'V1', reeferId: 'R1', slotCode: '02-03-82', scannerId: 'HH9' });
    assertEq(scan1.json.outcome, 'HELD', '无证进入待处理');
    assert(scan1.json.holdId, '返回待处理单号');

    // 插座/供电事实保持不变
    const base = (await api(proc, 'GET', '/api/state')).json;
    const sock = base.circuits.flatMap((c) => c.sockets).find((s) => s.id === 'S1');
    assertEq(sock.status, 'POWERED', '仍供电，插座事实不变');
    assertEq(sock.reeferId, 'R1', '仍绑定原箱');

    // 重复扫描幂等：同一 OPEN 待处理，不重复开单
    const scan2 = await post(proc, '/api/precert/scan',
      { voyageId: 'V1', reeferId: 'R1', slotCode: '02-03-82', scannerId: 'HH9' });
    assertEq(scan2.json.outcome, 'HELD', '仍待处理');
    assertEq(scan2.json.holdId, scan1.json.holdId, '回放同一待处理单');
    const holds = (await api(proc, 'GET', '/api/precert/state')).json.openHolds;
    assertEq(holds.length, 1, '只有一条待处理');

    // 取得合格证后重新扫描：放行并把待处理单置为已解决（此前无证扫描已使版本前进）
    await startObservation(proc, 'V1', 'R1', 'BOOT1');
    await tickQualify(proc, 'V1', 'R1', 'BOOT1');
    await post(proc, '/api/precert/certificates', { voyageId: 'V1', reeferId: 'R1' });
    // 扫描前补一条新鲜读数（证书仍有效，仅刷新读数时间）
    const tFresh = await clock(proc);
    await temp(proc, 'R1', 'BOOT1', null, tFresh);
    const scan3 = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan3.json.outcome, 'RELEASED', '补证后放行');
    const st = (await api(proc, 'GET', '/api/precert/state')).json;
    assertEq(st.openHolds.length, 0, '待处理队列清空');
    const resolved = st.holds.find((h) => h.id === scan1.json.holdId);
    assertEq(resolved.state, 'RESOLVED', '原待处理单已解决');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC6. 临时豁免带原因/负责人/有效期放行；后续超温立即自动撤销', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    // 无证先被拦
    const scan0 = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan0.json.outcome, 'HELD', '无证待处理');

    // 值班员提交带原因/有效期/货物负责人的临时豁免
    const ex = await post(proc, '/api/precert/exemptions', {
      voyageId: 'V1', reeferId: 'R1',
      reason: '到港时刻紧迫，温度趋势平稳',
      cargoOwner: '货主-张/LIC123',
      ttlMinutes: 30,
    });
    assert(ex.json.exemptionId, '豁免已签发');
    assertEq(ex.json.secondsRemaining, 1800, '豁免倒计时 30 分钟');

    // 豁免只覆盖本航次本箱
    let v = await pcView(proc, 'V1', 'R1');
    assertEq(v.release.allowed, true, '本航次放行');
    assertEq(v.release.basis, 'EXEMPTION', '放行依据为豁免');
    const other = await post(proc, '/api/precert/scan', { voyageId: 'V2', reeferId: 'R1' }, { expectStatus: 404 });
    assertEq(other.status, 404, '其他航次不被该豁免覆盖');

    const scan = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan.json.outcome, 'RELEASED', '豁免放行');

    // 出现新的超温读数 -> 豁免自动撤销
    const t = await clock(proc);
    await temp(proc, 'R1', 'BOOT1', -5, t); // 设定 -18，偏离 13℃
    v = await pcView(proc, 'V1', 'R1');
    assertEq(v.exemption.status, 'REVOKED', '豁免已撤销');
    assertEq(v.exemption.revokeReason, 'TEMP_EXCURSION', '撤销原因：超温');
    assertEq(v.release.allowed, false, '撤销后不再放行');
    const scan2 = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan2.json.outcome, 'HELD', '撤销后扫描再次进入待处理');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC7. 高风险货物使用更严稳定时间与偏差阈值，且不能用铭牌替代真实温度', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('RH', { grade: 'PHARMA', setpoint: 2, rise: 2 })]);
    const htemp = async (val, at) => post(proc, '/api/samples',
      { kind: 'temperature', reeferId: 'RH', sensorBootId: 'BOOT-H', measuredAt: at, value: val });
    // 无真实温度读数：不能开始观测/放行（不能以铭牌估算）
    const noTemp = await post(proc, '/api/precert/observe',
      { voyageId: 'V1', reeferId: 'RH' }, { expectStatus: 409 });
    assertEq(noTemp.json.error.code, 'NO_TEMPERATURE_READING', '无真实读数拒绝观测');
    const noCert = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'RH' });
    assertEq(noCert.json.outcome, 'HELD', '无真实温度不予放行');

    let tt = await clock(proc);
    await htemp(2.0, tt);
    await advance(proc, 150000);
    tt = await clock(proc);
    await htemp(2.0, tt);
    // 此前无证扫描已开 hold 使聚合版本前进，故观测不再钉死 expectedVersion
    await post(proc, '/api/precert/observe',
      { voyageId: 'V1', reeferId: 'RH', sensorBootId: 'BOOT-H' });
    const v0 = await pcView(proc, 'V1', 'RH');
    assertEq(v0.highRisk, true, '标记为高风险');
    assertEq(v0.params.requiredStableMs, 30 * 60000, '高风险稳定窗 30 分钟');
    assertEq(v0.params.maxDeviationC, 0.5, '高风险偏差阈值 0.5℃');

    // 到普通货物的 15 分钟仍不合格（2 分钟步长 ×8 = 16 分钟，读数在 3 分钟新鲜窗内）
    for (let i = 0; i < 8; i++) {
      await advance(proc, 150000);
      tt = await clock(proc);
      await htemp(2.0, tt);
    }
    const v1 = await pcView(proc, 'V1', 'RH');
    assertEq(v1.observation.qualified, false, '16 分钟对高风险不够（需 30）');

    // 继续合格读数补足 30 分钟，此时应合格
    for (let i = 0; i < 8; i++) {
      await advance(proc, 150000);
      tt = await clock(proc);
      await htemp(2.0, tt);
    }
    assertEq((await pcView(proc, 'V1', 'RH')).observation.qualified, true, '约 34 分钟合格读数后达标');

    // 再发偏离 0.8℃ 的读数：低风险合格、高风险不合格（截断合格后缀）
    await advance(proc, 150000);
    tt = await clock(proc);
    await htemp(2.8, tt);
    await advance(proc, 150000);
    tt = await clock(proc);
    await htemp(2.8, tt);
    const v2 = await pcView(proc, 'V1', 'RH');
    assertEq(v2.observation.qualified, false, '偏差 0.8℃ 超高风险阈值');
    const blocked = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'RH' }, { expectStatus: 409 });
    assertEq(blocked.json.error.code, 'NOT_QUALIFIED', '超偏差不签发');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC8. 设定点调整使证书立即失效并要求按新设定点重测', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    await startObservation(proc, 'V1', 'R1', 'BOOT1', 0);
    await tickQualify(proc, 'V1', 'R1', 'BOOT1');
    await post(proc, '/api/precert/certificates', { voyageId: 'V1', reeferId: 'R1', expectedVersion: 1 });

    await post(proc, '/api/precert/setpoint', { reeferId: 'R1', setpointC: -22 });
    const cert = await stateCert(proc, 'V1', 'R1');
    assertEq(cert.status, 'INVALID', '调整设定点使旧证书失效');
    assertEq(cert.invalidateReason, 'SETPOINT_CHANGED', '原因：设定点调整');
    assertEq(cert.restartHint.currentSetpointC, -22, '提示新设定点');
    assert(cert.restartHint.remainingMs >= 15 * 60000 - 1000, '需重新观测整个稳定窗');
    const scan = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan.json.outcome, 'HELD', '失效后拦截');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC9. 并发竞争签发收敛到单一证书；旧版本页面不能覆盖后来的失效状态', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    await startObservation(proc, 'V1', 'R1', 'BOOT1', 0);
    await tickQualify(proc, 'V1', 'R1', 'BOOT1');
    const ver = (await pcView(proc, 'V1', 'R1')).version;
    assertEq(ver, 1, '签发前聚合版本 1');

    // 两个并发签发，带相同 expectedVersion；服务端串行裁决，只允许一个赢
    const url = `http://localhost:${proc.port}/api/precert/certificates`;
    const body = JSON.stringify({ voyageId: 'V1', reeferId: 'R1', expectedVersion: 1 });
    const [a, b] = await Promise.all([
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-command-id': 'race-a' }, body }),
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-command-id': 'race-b' }, body }),
    ]);
    const codes = [a.status, b.status].sort();
    assertEq(codes, [200, 409], '一个成功一个冲突');
    const loser = a.status === 409 ? await a.json() : await b.json();
    assert(['VERSION_STALE', 'CERT_ACTIVE'].includes(loser.error.code), `负者错误码 ${loser.error.code}`);
    const st = (await api(proc, 'GET', '/api/precert/state')).json;
    assertEq(st.certificates.filter((c) => c.reeferId === 'R1' && c.status === 'ISSUED').length, 1,
      '竞争后只有一张有效证书');

    // 后续失效使版本前进：旧页面仍带旧 expectedVersion，不能覆盖失效状态
    const t = await clock(proc);
    await temp(proc, 'R1', 'BOOT2', null, t); // 传感器更换 -> 证书失效，版本前进
    const cur = (await pcView(proc, 'V1', 'R1')).version;
    assert(cur > 1, '失效后版本前进');
    const staleIssue = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'R1', expectedVersion: 1 }, { expectStatus: 409 });
    assertEq(staleIssue.json.error.code, 'VERSION_STALE', '旧页面签发被版本前置条件拒绝');
    assertEq(staleIssue.json.error.currentVersion, cur, '返回当前版本供刷新');
    const staleEx = await post(proc, '/api/precert/exemptions',
      { voyageId: 'V1', reeferId: 'R1', reason: 'x', cargoOwner: 'y', ttlMinutes: 10, expectedVersion: 1 },
      { expectStatus: 409 });
    assertEq(staleEx.json.error.code, 'VERSION_STALE', '旧页面豁免也被拒绝');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC10. operationId 首次结果语义：重放只返回首次证书，不产生第二张', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    await startObservation(proc, 'V1', 'R1', 'BOOT1', 0);
    await tickQualify(proc, 'V1', 'R1', 'BOOT1');
    const payload = { voyageId: 'V1', reeferId: 'R1', expectedVersion: 1, operationId: 'OP-FIRST' };
    const first = await post(proc, '/api/precert/certificates', payload, { commandId: 'issue-1' });
    const certId = first.json.certificateId;
    // 同命令标识重放：首次答复
    const replay = await post(proc, '/api/precert/certificates', payload, { commandId: 'issue-1' });
    assert(replay.json.replayed, '标记重放');
    assertEq(replay.json.certificateId, certId, '回放同一张合格证');
    const st = (await api(proc, 'GET', '/api/precert/state')).json;
    assertEq(st.certificates.filter((c) => c.reeferId === 'R1').length, 1, '没有产生第二张证书');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC11. 持久化边界崩溃恢复：证书/待处理状态与装船结果一致，失效不可复活', async () => {
  const dir = newDataDir();
  let proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    await startObservation(proc, 'V1', 'R1', 'BOOT1', 0);
    await tickQualify(proc, 'V1', 'R1', 'BOOT1');

    // 在“合格证事实落盘后、读模型归并前”崩溃
    await post(proc, '/test/faults/arm', { factType: 'certificateIssued' });
    const crashed = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'R1', expectedVersion: 1, operationId: 'OP-CRASH' },
      { tolerateCrash: true });
    await new Promise((r) => setTimeout(r, 500));

    proc = await restart(proc, dir);
    let cert = await stateCert(proc, 'V1', 'R1');
    assert(cert && cert.status === 'ISSUED', '重启后该观测区间只有一张有效证书');
    assertEq(cert.operationId, 'OP-CRASH', '绑定的 operationId 一致');

    // 同一观测区间不能签出第二张：重复签发冲突
    const again = await post(proc, '/api/precert/certificates',
      { voyageId: 'V1', reeferId: 'R1' }, { expectStatus: 409 });
    assertEq(again.json.error.code, 'CERT_ACTIVE', '已有有效证书');
    // 扫描放行结果与证书状态相符
    const scan = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan.json.outcome, 'RELEASED', '恢复后正常放行');

    // 待处理开单边界崩溃：事实落盘后重启，待处理仍在
    await seed(proc, [reefer('R2')], 'V9');
    await post(proc, '/test/faults/arm', { factType: 'loadingHoldRecorded' });
    await post(proc, '/api/precert/scan',
      { voyageId: 'V9', reeferId: 'R2', slotCode: '04-02-82' }, { tolerateCrash: true });
    await new Promise((r) => setTimeout(r, 500));
    proc = await restart(proc, dir);
    const holds = (await api(proc, 'GET', '/api/precert/state')).json.openHolds;
    const h = holds.find((x) => x.reeferId === 'R2' && x.voyageId === 'V9');
    assert(h, '重启后无证箱仍在待处理队列');
    assertEq(h.slotCode, '04-02-82', '槽位事实保留');

    // 已失效证书在再次重启后不能复活
    await post(proc, '/api/circuits/trip', { circuitId: 'C1' });
    cert = await stateCert(proc, 'V1', 'R1');
    assertEq(cert.status, 'INVALID', '掉电使证书失效');
    proc = await restart(proc, dir);
    cert = await stateCert(proc, 'V1', 'R1');
    assertEq(cert.status, 'INVALID', '重启后失效证书保持失效，不复活');
    const scan2 = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan2.json.outcome, 'HELD', '装船结果与失效状态相符');
  } finally {
    await stopServer(proc);
  }
});

// ---------------------------------------------------------------
test('PC12. 豁免到期自动撤销；纯时钟推进即失效，无需其他命令', async () => {
  const dir = newDataDir();
  const proc = await startServer(dir);
  try {
    await seed(proc, [reefer('R1')]);
    const ex = await post(proc, '/api/precert/exemptions', {
      voyageId: 'V1', reeferId: 'R1',
      reason: '短时效放行', cargoOwner: '负责人-LIC9', ttlMinutes: 5,
    });
    assert(ex.json.exemptionId, '豁免签发');
    let v = await pcView(proc, 'V1', 'R1');
    assertEq(v.release.allowed, true, '豁免期内放行');

    // 仅推进虚拟时钟越过有效期（无任何其他命令）-> 自动撤销
    await advance(proc, 5 * 60000 + 1000);
    v = await pcView(proc, 'V1', 'R1');
    assertEq(v.exemption.status, 'REVOKED', '豁免到期撤销');
    assertEq(v.exemption.revokeReason, 'EXPIRED', '撤销原因：到期');
    assertEq(v.release.allowed, false, '到期后不放行');
    const scan = await post(proc, '/api/precert/scan', { voyageId: 'V1', reeferId: 'R1' });
    assertEq(scan.json.outcome, 'HELD', '到期后扫描进入待处理');
  } finally {
    await stopServer(proc);
  }
});
