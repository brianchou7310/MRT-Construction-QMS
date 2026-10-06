/* 捷運施工品管系統 - 共用資料層 (IndexedDB) + 示範資料 + 業務規則
 * 後台 (admin.html) 與現場作業 (field.html) 共用同一個 IndexedDB，
 * 任一頁寫入後會透過 BroadcastChannel 通知另一頁重新載入。
 */
(function () {
  'use strict';
  const DB_NAME = 'mrt-qms', DB_VER = 1;
  const STORES = ['tenders', 'subworks', 'templates', 'selfChecks', 'requests', 'spotChecks', 'defects', 'docs', 'users', 'meta'];
  const H = 3600e3, D = 24 * H;
  const LINKED = { '5-4': '導溝施工自主檢查表', '5-6': '鋼筋籠自主檢查表', '5-7': '穩定液自主檢查紀錄表', '5-8': '連續壁超音波檢測紀錄表', '5-9': '連續壁混凝土灌漿紀錄表' };
  const JUDGE = { ok: '○ 合格', ng: '╳ 缺失', na: '╱ 無此項' };
  const STAGES = { pre: '施工前', during: '施工中', post: '施工後' };
  const DEFAULT_PARAMS = { id: 'params', holdAdvanceHours: 24, replyHours: 8, photoMaxKB: 400, defectDueDays: 7 };

  /* ---------- IndexedDB 基礎 ---------- */
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => { const db = r.result; STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const t = db.transaction(store, mode); let out;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  let bc = null; try { bc = new BroadcastChannel('mrt-qms'); } catch (e) { /* ignore */ }
  const listeners = [];
  if (bc) bc.onmessage = () => listeners.forEach(f => f());
  function notify() { if (bc) bc.postMessage('change'); }
  const all = s => tx(s, 'readonly', st => st.getAll());
  const get = (s, id) => tx(s, 'readonly', st => st.get(id));
  const put = (s, o) => tx(s, 'readwrite', st => st.put(clone(o))).then(() => { notify(); return o; });
  const del = (s, id) => tx(s, 'readwrite', st => st.delete(id)).then(() => notify());
  async function clearAll() { for (const s of STORES) await tx(s, 'readwrite', st => st.clear()); }
  async function putMany(s, arr) { for (const o of arr) await tx(s, 'readwrite', st => st.put(clone(o))); }

  /* ---------- 小工具 ---------- */
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  function fmtDT(ts) { if (!ts) return '—'; const d = new Date(ts); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function fmtD(ts) { if (!ts) return '—'; const d = new Date(ts); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; }
  function fmtFull(ts) { const d = new Date(ts); return `${fmtD(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function toLocalInput(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function fromLocalInput(s) { return s ? new Date(s).getTime() : 0; }
  function nextHour(offsetH) { const d = new Date(Date.now() + offsetH * H); d.setMinutes(0, 0, 0); return d.getTime(); }
  function atDay(offsetDays, h, m) { const d = new Date(); d.setDate(d.getDate() + offsetDays); d.setHours(h, m || 0, 0, 0); return d.getTime(); }
  function relTime(ts, now = Date.now()) {
    const diff = ts - now, a = Math.abs(diff), h = Math.floor(a / H), m = Math.floor((a % H) / 60000);
    const s = h >= 24 ? `${Math.floor(h / 24)} 天` : h > 0 ? `${h} 小時` : `${m} 分`;
    return diff < 0 ? { late: true, text: `逾時 ${s}` } : { late: false, text: `剩 ${s}`, soon: diff < 3 * H };
  }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  async function hashOf(obj) {
    const text = JSON.stringify(obj);
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0; return 'x' + h.toString(16); }
  }

  /* ---------- 檢查項目規則 ---------- */
  // 單一數值欄位判定：ok / ng / null(未填)
  function evalField(f, raw) {
    if (raw === '' || raw == null || isNaN(Number(raw))) return null;
    const v = Number(raw);
    if (f.min != null && f.min !== '' && v < Number(f.min)) return 'ng';
    if (f.max != null && f.max !== '' && v > Number(f.max)) return 'ng';
    return 'ok';
  }
  // 項目建議判定：所有有範圍的欄位都填了且全在容許範圍 → ok；任一超出 → ng
  function suggest(item, values) {
    const fs = (item.fields || []).filter(f => (f.min !== undefined && f.min !== '' && f.min !== null) || (f.max !== undefined && f.max !== '' && f.max !== null));
    if (!fs.length) return null;
    const rs = fs.map(f => evalField(f, (values || {})[f.key]));
    if (rs.includes('ng')) return 'ng';
    if (rs.every(r => r === 'ok')) return 'ok';
    return null;
  }
  function rangeText(f) {
    if (f.min !== undefined && f.min !== '' && f.min !== null && f.max !== undefined && f.max !== '' && f.max !== null) return `${f.min} ~ ${f.max}`;
    if (f.max !== undefined && f.max !== '' && f.max !== null) return `≤ ${f.max}`;
    if (f.min !== undefined && f.min !== '' && f.min !== null) return `≥ ${f.min}`;
    return '';
  }
  function stageItems(tpl, stage) { return tpl.items.filter(i => i.stage === stage); }
  function stageDone(sc, tpl, stage) { return stageItems(tpl, stage).every(i => sc.answers[i.no] && sc.answers[i.no].judge); }
  // 鎖定原因：前一階段未完成 / 前面有停留點尚未放行
  function lockReason(sc, tpl, item) {
    const order = ['pre', 'during', 'post'];
    const si = order.indexOf(item.stage);
    for (let k = 0; k < si; k++) if (!stageDone(sc, tpl, order[k])) return `請先完成${STAGES[order[k]]}項目`;
    const blocker = tpl.items.find(i => i.hold && i.no < item.no && (sc.hold[i.no] || {}).state !== 'passed');
    if (blocker) return `待 ☆${blocker.name} 監造放行`;
    return null;
  }
  const holdState = (sc, no) => (sc.hold[no] || { state: 'none' }).state;
  const HOLD_TEXT = { none: '未申請', applied: '待回覆', scheduled: '已排定', passed: '已合格放行', failed: '不合格', rejected: '已退回' };
  const REQ_TEXT = { pending: '待回覆', scheduled: '已排定', inspecting: '檢驗中', passed: '合格放行', failed: '不合格', rejected: '已退回' };

  /* ---------- 示範資料 ---------- */
  const F = (key, label, unit, min, max) => ({ key, label, unit, min: min == null ? '' : min, max: max == null ? '' : max });
  const I = (no, stage, name, std, o = {}) => Object.assign({ no, stage, name, std, type: 'option', fields: [], hold: false, photo: false, linked: '', ref: 'CF671-PL-0032' }, o);

  function items55() {
    return [
      I(1, 'pre', '導溝施作', '詳導溝施工自主檢查表', { type: 'linked', linked: '5-4' }),
      I(2, 'pre', '單元位置', '放樣於導溝面上，詳施工圖', { type: 'number', photo: true, fields: [F('len', '單元長度', 'm'), F('el', '導溝高程 EL', 'm')] }),
      I(3, 'pre', '鋼筋籠製作', '詳鋼筋籠施工自主檢查表', { type: 'linked', linked: '5-6' }),
      I(4, 'pre', '穩定液液面高度控制', '不低於內導溝面下（GL-0.5m ± 5cm）', { type: 'number', fields: [F('gl', '穩定液面高程 GL', 'm', -0.55, -0.45)] }),
      I(5, 'during', '開挖寬度及深度', '1. 寬度 100 ± 5cm\n2. 不得超過設計深度 50cm', { type: 'number', fields: [F('w', '寬度', 'cm', 95, 105), F('over', '超挖深度', 'cm', null, 50)] }),
      I(6, 'during', '端鈑處理（公單元、母單元）', '先施作單元端部鋼刷清除汙泥與雜物', { photo: true }),
      I(7, 'during', '溝底沉泥清除及深度確認', '實際深度 ≥ 設計深度\nS1 溝底 EL=98.5／S2 EL=96.0／S3 EL=101.0', { type: 'number', fields: [F('s1', 'S1 溝底 EL', 'm', null, 98.5)] }),
      I(8, 'during', '垂直度（超音波檢測）', '≦ 1/300', { type: 'number', hold: true, photo: true, fields: [F('v', '垂直度 1/N 之 N', '', 300)] }),
      I(9, 'during', '穩定液檢測（澆置混凝土前）', '詳連續壁穩定液自主檢查紀錄表', { type: 'linked', linked: '5-7', hold: true }),
      I(10, 'during', '鋼筋籠吊放高程及位置確認', '壁體垂直方向偏差 25mm\n其他方向 75mm\n鋼筋籠頂高程 EL 122.9m', { type: 'number', hold: true, photo: true, fields: [F('dv', '垂直方向偏差', 'mm', null, 25), F('do', '其他方向', 'mm', null, 75), F('el', '籠頂高程 EL', 'm', 122.85, 122.95)] }),
      I(11, 'during', '特密管安裝', '1. 出口離槽底面 1.5m 以內\n2. 特密管長度符合開挖深度\n4. 特密管間距 ≦ 300cm', { type: 'number', hold: true, fields: [F('gap', '出口離槽底', 'm', null, 1.5), F('sp', '特密管間距', 'cm', null, 300)] }),
      I(12, 'during', '混凝土試體取樣', "1. fc' ≧ 250 kgf/cm²\n2. 溫度 ≦ 32°C\n3. 坍度 19 ± 4.0cm", { type: 'number', hold: true, fields: [F('fc', "fc'", 'kgf/cm²', 250), F('t', '溫度', '°C', null, 32), F('s', '坍度', 'cm', 15, 23)] }),
      I(13, 'during', '端鈑外回填碎石（母單元、公母單元）', '碎石回填 2m', { type: 'number', fields: [F('h', '回填高', 'm', 2)] }),
      I(14, 'during', '混凝土澆置紀錄', '詳連續壁混凝土灌漿紀錄表', { type: 'linked', linked: '5-9' }),
      I(15, 'post', '場地清理', '是否清理完成'),
      I(16, 'post', '開口安衛措施', '護欄、鐵板或核可材料覆蓋', { hold: true, photo: true })
    ];
  }
  function mini(id, subworkId, kind, code, name, n, extra) {
    const its = [];
    for (let i = 1; i <= n; i++) its.push(I(i, i === 1 ? 'pre' : i < n ? 'during' : 'post', `${name} 檢查項目 ${i}`, '依施工圖及規範', { type: i % 2 ? 'option' : 'number', fields: i % 2 ? [] : [F('v', '實測值', 'mm', null, 25)] }));
    return Object.assign({ id, tenderId: 'T671', subworkId, kind, code, name, version: 1, status: 'published', source: 'CF671-PL-0032', items: its, used: 0 }, extra || {});
  }

  function buildSeed() {
    const now = Date.now();
    const out = { tenders: [], subworks: [], templates: [], selfChecks: [], requests: [], spotChecks: [], defects: [], docs: [], users: [], meta: [] };
    out.tenders.push(
      { id: 'T671', code: 'CF671', name: 'CF671 土建標', status: '施工中', contractor: '大陸工程股份有限公司', supervisor: '臺北市政府捷運工程局第二區工程處', site: 'Y01 站及區間隧道', start: '2024/03/01', end: '2028/12/31', external: '（日後串接標案管理系統）', desc: '隸屬 CF670A 臺北都會區大眾捷運系統環狀線南環段 CF670A 區段標工程', members: 6 },
      { id: 'T624', code: 'CF624H', name: 'CF624H 水環標', status: '施工中', contractor: '遠揚營造股份有限公司', supervisor: '臺北市政府捷運工程局第二區工程處', site: '隧道（地下）排水系統', start: '2024/06/01', end: '2028/06/30', external: '', desc: '隸屬 CF670A 區段標工程', members: 4 }
    );
    const sw = [['一', '鋼板樁工程', 296, 'M'], ['二', '開挖支撐工程', 1, '式'], ['三', '車站開挖祛水系統', 1, '式'], ['四', '構造物回填工程', 19470, 'M3'], ['五', '連續壁工程', 15550, 'M2'], ['六', '鑽掘混凝土基樁工程', 6315, 'M'], ['七', '營建剩餘資源處理工程', 192575, 'M3'], ['八', '模板組立工程', 93026, 'M2'], ['九', '鋼筋工程', 11038, 'T'], ['十', '預拌混凝土工程', 50299, 'M3'], ['十一', '接地系統工程', 1, '式'], ['十二', '政大宿舍拆除工程', 1, '式'], ['十三', '舊廣路銅橋橋新建（含拆除）工程', 1, '式'], ['十四', '臨時排水工程', 1, '式'], ['十五', '地下調查工程', 1, '式']];
    sw.forEach((s, i) => out.subworks.push({ id: 'S671-' + (i + 1), tenderId: 'T671', no: s[0], name: s[1], qty: s[2], unit: s[3], status: '施工中', order: i }));
    [['隧道（地下）工程', 4], ['車站工程', 23]].forEach((s, i) => out.subworks.push({ id: 'S624-' + (i + 1), tenderId: 'T624', no: ['一', '二'][i], name: s[0], qty: 1, unit: '式', status: '施工中', order: i }));

    // 範本
    const t55 = { id: 'TP-5-5', tenderId: 'T671', subworkId: 'S671-5', kind: 'self', code: '5-5', name: '連續壁施工自主檢查表', version: 1, status: 'published', source: 'CF671-PL-0032 Y01站連續壁工計畫書 第5章 品質管理（p.5-10~5-11）', items: items55(), used: 2 };
    const spotItems = items55().map(i => { i.srcNo = i.no; i.hold = [4, 8, 9, 10, 11, 12, 16].includes(i.no); return i; });
    const tSpot = { id: 'TP-SP-1', tenderId: 'T671', subworkId: 'S671-5', kind: 'spot', code: 'SP-5', name: '連續壁施工品質抽查記錄表', version: 1, status: 'published', source: 'CF671-PL-0032 連續壁工計畫書 p.5-20~5-21', pairedSelf: 'TP-5-5', items: spotItems, used: 1 };
    out.templates.push(t55, tSpot);
    out.templates.push(mini('TP-5-4', 'S671-5', 'self', '5-4', '導溝施工自主檢查表', 5), mini('TP-5-6', 'S671-5', 'self', '5-6', '鋼筋籠自主檢查表', 6), mini('TP-5-7', 'S671-5', 'self', '5-7', '穩定液自主檢查紀錄表', 4), mini('TP-5-8', 'S671-5', 'self', '5-8', '連續壁超音波檢測紀錄表', 4), mini('TP-5-9', 'S671-5', 'self', '5-9', '連續壁混凝土灌漿紀錄表', 4));
    out.templates.push(mini('TP-SP-2', 'S671-5', 'spot', 'SP-6', '連續壁鋼筋籠施工品質抽查記錄表', 5), mini('TP-SP-3', 'S671-5', 'spot', 'SP-7', '連續壁穩定液施工品質抽查記錄表', 4), mini('TP-SP-0', 'S671-5', 'spot', 'SP-4', '導溝施工品質抽查記錄表', 5));
    [[1, '鋼板樁'], [2, '開挖支撐'], [6, '鑽掘混凝土基樁'], [8, '模板組立'], [9, '鋼筋'], [10, '預拌混凝土']].forEach(([n, nm]) => out.templates.push(mini('TP-S' + n, 'S671-' + n, 'self', '1-' + n, nm + '自主檢查表', 4)));
    out.templates.find(t => t.id === 'TP-S2').used = 2;

    // 參考文件
    [['CF671-PL-0032', 'Y01 站連續壁工計畫書', '第5章 品質管理（p.5-10~5-21）'], ['CF671-DW-0101', '連續壁施工圖', 'Y01 站 單元配置'], ['CF671-SP-0005', '施工規範 03310 混凝土', '坍度、溫度及試體規定'], ['CF671-SP-0007', '施工規範 02450 連續壁', '垂直度及穩定液管理']].forEach(d => out.docs.push({ id: d[0], code: d[0], name: d[1], note: d[2] }));
    out.users.push(
      { id: 'U1', name: '系統管理員', role: '系統管理員', org: '第二區工程處', email: 'admin@example.com' },
      { id: 'U2', name: '示範品管', role: '廠商品管人員', org: '大陸工程股份有限公司', email: 'qc@contractor.example.com' },
      { id: 'U3', name: '示範工地主任', role: '工地授權代表', org: '大陸工程股份有限公司', email: 'lead@contractor.example.com' },
      { id: 'U4', name: '示範監造', role: '監造現場工程師', org: '監造工務所', email: 'sv@supervisor.example.com' },
      { id: 'U5', name: '示範工務所主任', role: '監造工務所主任', org: '監造工務所', email: 'chief@supervisor.example.com' }
    );
    out.meta.push(clone(DEFAULT_PARAMS), { id: 'counter', req: 3, sc: 2, defect: 5, spot: 1 });

    // 進行中的自主檢查（P12）
    const ans = {};
    const J = (no, judge, values, photos) => { ans[no] = { judge, values: values || {}, photos: photos || [], note: '' }; };
    J(1, 'ok'); J(2, 'ok', { len: 6, el: 124.05 }, ['*']); J(3, 'ok'); J(4, 'ok', { gl: -0.48 });
    J(5, 'ok', { w: 103, over: 12 }); J(6, 'ok', {}, ['*']); J(7, 'ok', { s1: 98.42 });
    J(8, 'ok', { v: 420 }, ['*']); J(9, 'ok'); J(10, 'ok', { dv: 18, do: 40, el: 122.91 }, ['*', '*', '*']);
    const sc = {
      id: 'SC-CF671-261005-002', tenderId: 'T671', tenderCode: 'CF671', templateId: 'TP-5-5', templateVer: 1, templateCode: '5-5', templateName: '連續壁施工自主檢查表',
      subworkId: 'S671-5', subworkName: 'Y01站連續壁施工', unit: 'P12', location: 'Y01站 單元 P12（公單元）', date: now, contractor: '大陸工程股份有限公司',
      status: 'draft', answers: ans, linked: { '5-4': true, '5-6': true, '5-7': true }, qrConfirmed: true, drawingNo: '',
      hold: { 8: { state: 'passed', requestId: 'HP-CF671-1002-001' }, 9: { state: 'passed', requestId: 'HP-CF671-1002-002' }, 10: { state: 'applied', requestId: 'HP-CF671-1004-003' } },
      recovery: '', signatures: {}, createdAt: now - 10 * H, updatedAt: now - H
    };
    out.selfChecks.push(sc);
    // 已簽認完成的 P11
    const ans2 = {}, hold2 = {};
    items55().forEach(it => { ans2[it.no] = { judge: 'ok', values: {}, photos: it.photo ? ['*'] : [], note: '' }; if (it.hold) hold2[it.no] = { state: 'passed', requestId: '' }; });
    out.selfChecks.push({ id: 'SC-CF671-260930-001', tenderId: 'T671', tenderCode: 'CF671', templateId: 'TP-5-5', templateVer: 1, templateCode: '5-5', templateName: '連續壁施工自主檢查表', subworkId: 'S671-5', subworkName: 'Y01站連續壁施工', unit: 'P11', location: 'Y01站 單元 P11（母單元）', date: now - 5 * D, contractor: '大陸工程股份有限公司', status: 'signed', answers: ans2, linked: { '5-4': true, '5-6': true, '5-7': true }, qrConfirmed: true, drawingNo: 'CF671-DW-0101', hold: hold2, recovery: '', signatures: { site: { img: '', at: now - 5 * D, name: '示範品管' }, rep: { img: '', at: now - 5 * D, name: '示範工地主任' } }, hash: 'cc161bb0demo', createdAt: now - 5 * D, updatedAt: now - 5 * D });

    // 停留點申請
    const A = now - 9 * H;
    out.requests.push({
      id: 'HP-CF671-1004-003', tenderId: 'T671', tenderCode: 'CF671', scId: sc.id, itemNo: 10, title: '鋼筋籠吊放高程及位置確認', subworkName: '連續壁工程', checkName: '表5-5 連續壁施工自主檢查表', location: 'Y01站 單元 P12（公單元）', unit: 'P12',
      appliedAt: A, replyDue: A + 8 * H, scheduledAt: A + 18 * H, applicant: '大陸工程 品管人員', status: 'pending', shortNotice: true, shortReason: '配合混凝土車預約時段，需於明早吊放完成。', inspector: '', photoCount: 3,
      std: '壁體垂直方向偏差 25mm\n其他方向 75mm\n鋼筋籠頂高程 EL 122.9m', values: { dv: 18, do: 40, el: 122.91 },
      notices: [{ at: A, text: '廠商送出會驗申請（附照片 3 張）', level: 'info' }, { at: A, text: 'Email 已寄送監造人員（2 位）', level: 'info' }]
    });
    const mkReq = (id, title, loc, applied, sched, status, sw) => ({ id, tenderId: 'T671', tenderCode: 'CF671', scId: '', itemNo: 0, title, subworkName: sw || '連續壁工程', checkName: '', location: loc, unit: '', appliedAt: applied, replyDue: applied + 8 * H, scheduledAt: sched, applicant: '大陸工程 品管人員', status, shortNotice: false, shortReason: '', inspector: status === 'pending' ? '' : '示範監造', photoCount: 2, std: '依施工圖及規範', values: {}, notices: [{ at: applied, text: '廠商送出會驗申請', level: 'info' }, { at: applied, text: 'Email 已寄送監造人員（2 位）', level: 'info' }] });
    out.requests.push(
      mkReq('HP-CF671-1005-001', '混凝土澆注', 'Y01站 導溝 G05~G08', now - 3 * H, atDay(1, 8, 30), 'pending', '導溝工程'),
      mkReq('HP-CF671-1005-002', '護耳置放位置、間隔', '鋼筋籠加工場 P14', now - H, atDay(1, 14, 0), 'pending', '鋼筋籠工程'),
      mkReq('HP-CF671-1003-001', '鋼筋籠加工場放樣', '鋼筋籠加工場 P13', now - 30 * H, atDay(0, 15, 0), 'scheduled', '鋼筋籠工程'),
      mkReq('HP-CF671-1003-002', '圍檁抽查（穩定液）', 'Y01站 單元 P13', now - 28 * H, atDay(0, 13, 30), 'scheduled', '連續壁工程'),
      mkReq('HP-CF671-1002-001', '垂直度（超音波檢測）', 'Y01站 單元 P12', now - 3 * D, now - 2 * D, 'passed'),
      mkReq('HP-CF671-1002-002', '穩定液檢測（澆置混凝土前）', 'Y01站 單元 P12', now - 3 * D, now - 2 * D, 'passed'),
      mkReq('HP-CF671-0929-001', '垂直度（超音波檢測）', 'Y01站 單元 P10', now - 8 * D, now - 7 * D, 'failed')
    );
    // 抽查（已完成）
    out.spotChecks.push({ id: 'SP-CF671-1002-001', requestId: 'HP-CF671-1002-001', scId: '', itemNo: 8, templateId: 'TP-SP-1', title: '垂直度（超音波檢測）', tenderCode: 'CF671', location: 'Y01站 單元 P12', measures: {}, judge: 'ok', photos: [], calc: { thickness: '1.0', length: '6.0', depth: '32' }, status: 'signed', signatures: {}, createdAt: now - 2 * D, subworkId: 'S671-5' });
    out.spotChecks.push({ id: 'SP-CF671-0930-001', requestId: 'HP-CF671-0929-001', scId: '', itemNo: 8, templateId: 'TP-SP-1', title: '垂直度（超音波檢測）', tenderCode: 'CF671', location: 'Y01站 單元 P10', measures: {}, judge: 'ng', photos: [], calc: {}, status: 'signed', signatures: {}, createdAt: now - 7 * D, subworkId: 'S671-5' });
    // 缺失
    const dd = (n, t, loc, code, due, st, sw) => ({ id: 'DF-' + pad(n, 4), tenderId: code === 'CF671' ? 'T671' : 'T624', tenderCode: code, title: t, location: loc, source: '抽查', refId: '', itemNo: 0, subworkId: sw || 'S671-5', createdAt: due - 7 * D, due, status: st, note: '' });
    out.defects.push(
      dd(1, '鋼筋籠點焊有裂脆', 'CF671｜連續壁工程-鋼筋籠 P10', 'CF671', now - 2 * D, 'open'),
      dd(2, '排水管坡度不足', 'CF624H｜隧道排水系統-南下線', 'CF624H', now - D, 'open', 'S624-1'),
      dd(3, '開口安衛覆蓋不完整', 'CF671｜連續壁工程 P09', 'CF671', now + 3 * D, 'review'),
      dd(4, '穩定液比重超標', 'CF671｜連續壁工程 P08', 'CF671', now + 4 * D, 'open'),
      dd(5, '導溝高程偏差', 'CF671｜導溝工程 G05', 'CF671', now + 5 * D, 'open', 'S671-4')
    );
    return out;
  }

  /* ---------- 初始化與重置 ---------- */
  async function seed(force) {
    if (!force && await get('meta', 'seeded')) return;
    if (force) await clearAll();
    const d = buildSeed();
    for (const s of Object.keys(d)) await putMany(s, d[s]);
    await put('meta', { id: 'seeded', at: Date.now() });
  }
  const ready = open().then(() => seed(false)).then(() => tickOverdue());

  async function getParams() { return Object.assign({}, DEFAULT_PARAMS, await get('meta', 'params') || {}); }
  async function counter(name) {
    const c = (await get('meta', 'counter')) || { id: 'counter' };
    c[name] = (c[name] || 0) + 1; await put('meta', c); return c[name];
  }

  /* ---------- 業務流程 ---------- */
  // 逾時回覆：寄提醒並往上通知主管（只記錄一次）
  async function tickOverdue() {
    const now = Date.now(); const reqs = await all('requests');
    for (const r of reqs) {
      if (r.status === 'pending' && now > r.replyDue && !r.overdueNotified) {
        r.overdueNotified = true;
        r.notices.push({ at: r.replyDue, text: '回覆期限到期，寄出逾時提醒 Email', level: 'warn' });
        r.notices.push({ at: r.replyDue + 3600e3 > now ? now : r.replyDue + 3600e3, text: '逾時未回覆，往上通知主管（第二區工程處 主任工程司）', level: 'danger' });
        await put('requests', r);
      }
    }
  }

  async function newSelfCheck({ templateId, unit, location, drawingNo }) {
    const tpl = await get('templates', templateId), tender = await get('tenders', tpl.tenderId), sw = await get('subworks', tpl.subworkId);
    const n = await counter('sc'); const d = new Date();
    const sc = {
      id: `SC-${tender.code}-${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(n, 3)}`,
      tenderId: tender.id, tenderCode: tender.code, templateId: tpl.id, templateVer: tpl.version, templateCode: tpl.code, templateName: tpl.name,
      subworkId: sw.id, subworkName: 'Y01站' + sw.name.replace('工程', '') + '施工', unit, location: location || `Y01站 單元 ${unit}`, date: Date.now(), contractor: tender.contractor,
      status: 'draft', answers: {}, linked: {}, qrConfirmed: false, drawingNo: drawingNo || '', hold: {}, recovery: '', signatures: {}, createdAt: Date.now(), updatedAt: Date.now()
    };
    await put('selfChecks', sc); return sc;
  }
  async function saveSelf(sc) { sc.updatedAt = Date.now(); return put('selfChecks', sc); }

  async function applyHold(scId, itemNo, { scheduledAt, reason, location }) {
    const sc = await get('selfChecks', scId), tpl = await get('templates', sc.templateId), it = tpl.items.find(i => i.no === itemNo), p = await getParams();
    const now = Date.now(), short = (scheduledAt - now) < p.holdAdvanceHours * H;
    if (short && !(reason || '').trim()) throw new Error(`距預定會驗不足 ${p.holdAdvanceHours} 小時，請填寫原因`);
    const n = await counter('req'); const d = new Date();
    const a = sc.answers[itemNo] || { values: {}, photos: [] };
    const req = {
      id: `HP-${sc.tenderCode}-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(n, 3)}`, tenderId: sc.tenderId, tenderCode: sc.tenderCode, scId, itemNo, title: it.name,
      subworkName: sc.subworkName, checkName: `表${sc.templateCode} ${sc.templateName}`, location: location || sc.location, unit: sc.unit, appliedAt: now, replyDue: now + p.replyHours * H, scheduledAt,
      applicant: '大陸工程 品管人員', status: 'pending', shortNotice: short, shortReason: short ? reason : '', inspector: '', photoCount: (a.photos || []).length, std: it.std, values: clone(a.values || {}),
      notices: [{ at: now, text: `廠商送出會驗申請（附照片 ${(a.photos || []).length} 張）`, level: 'info' }, { at: now, text: 'Email 已寄送監造人員（2 位）', level: 'info' }]
    };
    sc.hold[itemNo] = { state: 'applied', requestId: req.id };
    await put('requests', req); await saveSelf(sc); return req;
  }
  async function syncHold(req, state) {
    if (!req.scId) return;
    const sc = await get('selfChecks', req.scId); if (!sc) return;
    sc.hold[req.itemNo] = { state, requestId: req.id }; await saveSelf(sc);
  }
  async function schedule(reqId, ts, inspector, isReschedule) {
    const r = await get('requests', reqId);
    r.scheduledAt = ts; r.inspector = inspector || r.inspector; r.status = 'scheduled';
    r.notices.push({ at: Date.now(), text: `${isReschedule ? '監造改期為' : '監造確認排定'} ${fmtDT(ts)}，指派 ${r.inspector}`, level: 'ok' });
    await put('requests', r); await syncHold(r, 'scheduled'); return r;
  }
  async function reject(reqId, reason) {
    const r = await get('requests', reqId);
    r.status = 'rejected'; r.notices.push({ at: Date.now(), text: `監造退回申請：${reason || '（未填原因）'}`, level: 'danger' });
    await put('requests', r); await syncHold(r, 'none'); return r;
  }
  async function startInspection(reqId) {
    const r = await get('requests', reqId);
    if (r.spotId) return get('spotChecks', r.spotId);
    const n = await counter('spot'); const d = new Date();
    const sc = r.scId ? await get('selfChecks', r.scId) : null;
    const sp = {
      id: `SP-${r.tenderCode}-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(n, 3)}`, requestId: r.id, scId: r.scId, itemNo: r.itemNo, templateId: 'TP-SP-1', subworkId: sc ? sc.subworkId : 'S671-5',
      title: r.title, tenderCode: r.tenderCode, location: r.location, unit: r.unit, measures: {}, judge: null, photos: [], calc: { thickness: '1.0', length: sc && sc.answers[2] ? String((sc.answers[2].values || {}).len || '') : '', depth: '' },
      status: 'draft', signatures: {}, createdAt: Date.now()
    };
    r.status = 'inspecting'; r.spotId = sp.id; r.notices.push({ at: Date.now(), text: '監造開始會驗', level: 'info' });
    await put('spotChecks', sp); await put('requests', r); return sp;
  }
  async function createDefect({ tenderCode, title, location, source, refId, itemNo, subworkId }) {
    const n = await counter('defect'), p = await getParams(), now = Date.now();
    const df = { id: 'DF-' + pad(n, 4), tenderId: tenderCode === 'CF671' ? 'T671' : 'T624', tenderCode, title, location, source, refId, itemNo, subworkId: subworkId || '', createdAt: now, due: now + p.defectDueDays * D, status: 'open', note: '' };
    await put('defects', df); return df;
  }
  // 自主檢查表兩位簽認完成後鎖定
  async function finalizeSelf(scId) {
    const sc = await get('selfChecks', scId); const tpl = await get('templates', sc.templateId);
    sc.hash = await hashOf({ a: sc.answers, l: sc.linked, h: sc.hold, r: sc.recovery, t: sc.templateId, v: sc.templateVer });
    sc.status = 'signed'; await saveSelf(sc);
    for (const it of tpl.items) {
      if ((sc.answers[it.no] || {}).judge === 'ng') await createDefect({ tenderCode: sc.tenderCode, title: it.name, location: `${sc.tenderCode}｜${sc.subworkName} ${sc.unit}`, source: '自主檢查', refId: sc.id, itemNo: it.no, subworkId: sc.subworkId });
    }
    return sc;
  }
  async function finalizeSpot(spId) {
    const sp = await get('spotChecks', spId); const r = await get('requests', sp.requestId);
    sp.hash = await hashOf({ m: sp.measures, j: sp.judge, c: sp.calc });
    sp.status = 'signed'; await put('spotChecks', sp);
    const pass = sp.judge !== 'ng';
    r.status = pass ? 'passed' : 'failed';
    r.notices.push({ at: Date.now(), text: pass ? '抽查完成，合格放行（後續項目解鎖）' : '抽查判定有缺失，不合格', level: pass ? 'ok' : 'danger' });
    await put('requests', r); await syncHold(r, pass ? 'passed' : 'failed');
    if (!pass) await createDefect({ tenderCode: sp.tenderCode, title: sp.title, location: `${sp.tenderCode}｜${sp.location}`, source: '抽查', refId: sp.id, itemNo: sp.itemNo, subworkId: sp.subworkId });
    return sp;
  }
  async function setDefectStatus(id, status, note) {
    const d = await get('defects', id); d.status = status; if (note != null) d.note = note; if (status === 'closed') d.closedAt = Date.now(); return put('defects', d);
  }

  /* ---------- 版本控制 ---------- */
  // 範本已被使用 → 另存為新版本；未使用 → 直接覆寫
  async function saveTemplate(tpl, asNewVersion) {
    if (!asNewVersion) return put('templates', tpl);
    const old = await get('templates', tpl.id);
    old.status = 'superseded'; await put('templates', old);
    const nv = clone(tpl); nv.id = tpl.id.replace(/-v\d+$/, '') + '-v' + (tpl.version + 1); nv.version = tpl.version + 1; nv.status = 'published'; nv.used = 0;
    await put('templates', nv); return nv;
  }

  window.QMS = {
    ready, open, all, get, put, del, seed, getParams, onChange: f => listeners.push(f),
    LINKED, JUDGE, STAGES, HOLD_TEXT, REQ_TEXT, H, D,
    fmtDT, fmtD, fmtFull, toLocalInput, fromLocalInput, nextHour, atDay, relTime, uid, clone, hashOf,
    evalField, suggest, rangeText, stageItems, stageDone, lockReason, holdState,
    tickOverdue, newSelfCheck, saveSelf, applyHold, schedule, reject, startInspection, createDefect, finalizeSelf, finalizeSpot, setDefectStatus, saveTemplate, putMany, F, I
  };
})();
