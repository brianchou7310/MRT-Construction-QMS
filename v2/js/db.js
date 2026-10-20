/* 捷運施工查驗系統 - 共用資料層 (IndexedDB) + 示範資料 + 業務規則
 * 後台 (admin.html) 與現場作業 (field.html) 共用同一個 IndexedDB，
 * 任一頁寫入後會透過 BroadcastChannel 通知另一頁重新載入。
 */
(function () {
  'use strict';
  const DB_NAME = 'mrt-qms-v2', DB_VER = 1;
  const STORES = ['tenders', 'subworks', 'templates', 'selfChecks', 'requests', 'spotChecks', 'defects', 'docs', 'users', 'meta'];
  const H = 3600e3, D = 24 * H;
  const LINKED = { '5-4': '導溝施工自主檢查表', '5-6': '鋼筋籠自主檢查表', '5-7': '穩定液自主檢查紀錄表', '5-8': '連續壁超音波檢測紀錄表', '5-9': '連續壁混凝土灌漿紀錄表' };
  const JUDGE = { ok: '○ 合格', ng: '╳ 缺失', na: '╱ 無此項' };
  const STAGES = { pre: '施工前', during: '施工中', post: '施工後' };
  // 階段可依表單自訂（例：挖掘前／挖掘中／挖掘後），未設定時用預設的施工前／中／後
  const DEF_STAGES = [{ key: 'pre', name: '施工前' }, { key: 'during', name: '施工中' }, { key: 'post', name: '施工後' }];
  const stagesOf = tpl => (tpl && tpl.stages && tpl.stages.length ? tpl.stages : DEF_STAGES);
  const stageName = (tpl, key) => (stagesOf(tpl).find(s => s.key === key) || {}).name || STAGES[key] || key;
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
  let bc = null; try { bc = new BroadcastChannel('mrt-qms-v2'); } catch (e) { /* ignore */ }
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
    const order = stagesOf(tpl).map(s => s.key);
    const si = order.indexOf(item.stage);
    for (let k = 0; k < si; k++) if (!stageDone(sc, tpl, order[k])) return `請先完成${stageName(tpl, order[k])}項目`;
    const blocker = tpl.items.find(i => i.hold && i.no < item.no && (sc.answers[i.no] || {}).judge !== 'na' && (sc.hold[i.no] || {}).state !== 'passed');
    if (blocker) return (sc.answers[blocker.no] || {}).judge === 'ng' ? `待 ☆${blocker.name} 缺失改善、重新判定並經監造放行` : `待 ☆${blocker.name} 監造放行`;
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
    return Object.assign({ id, tenderId: 'T671', subworkId, kind, code, name, version: 1, status: 'published', source: 'CF671-PL-0032', fillMode: 'online', items: its, used: 0 }, extra || {});
  }

  // 空白 PDF 範本（離線填寫）：items 為空，檔案存於 pdf 欄位
  function dataUrlSize(u) { return Math.round((u.length - u.indexOf(',') - 1) * 0.75); }
  function pdfTpl(id, subworkId, kind, code, name, file) {
    const data = (window.SAMPLE_PDFS || {})[file] || '';
    return { id, tenderId: 'T671', subworkId, kind, code, name, version: 1, status: 'published', source: '空白範本 PDF', fillMode: 'pdf', pdf: data ? { name: file, size: dataUrlSize(data), data, at: Date.now() } : null, items: [], used: 0 };
  }
  function pdfBlobUrl(dataUrl) {
    if (!dataUrl) return '';
    const i = dataUrl.indexOf(','), bin = atob(dataUrl.slice(i + 1)), buf = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
    return URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
  }
  function downloadPdf(f) { const u = pdfBlobUrl(f.data), a = document.createElement('a'); a.href = u; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 3000); }
  function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
  // 任意檔案（參考文件）：data URL → Blob，保留原始檔案類型
  function fileBlobUrl(dataUrl) {
    if (!dataUrl) return ''; const i = dataUrl.indexOf(','), mime = (dataUrl.slice(5, i).split(';')[0]) || 'application/octet-stream', bin = atob(dataUrl.slice(i + 1)), buf = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
    return URL.createObjectURL(new Blob([buf], { type: mime }));
  }
  function downloadAny(f) { const u = fileBlobUrl(f.data), a = document.createElement('a'); a.href = u; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 3000); }
  function openAny(f) { const u = fileBlobUrl(f.data); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60000); }
  const canPreview = f => !!f && /^data:(application\/pdf|image\/)/.test(f.data || '');
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function buildSeed() {
    const now = Date.now();
    const out = { tenders: [], subworks: [], templates: [], selfChecks: [], requests: [], spotChecks: [], defects: [], docs: [], users: [], meta: [] };
    // 標案：與標案管理系統（ProjBase）真實資料一致
    out.tenders.push(Object.assign(tenderFromProj(SEED_PROJ.CF671, SEED_PROJ.CF670A), { id: 'T671', members: 6, addedAt: 0 }), Object.assign(tenderFromProj(SEED_PROJ.CF624H, SEED_PROJ.CF670A), { id: 'T624', members: 4, addedAt: 0 }));
    const sw = [['一', '鋼板樁工程', 296, 'M'], ['二', '開挖支撐工程', 1, '式'], ['三', '車站開挖祛水系統', 1, '式'], ['四', '構造物回填工程', 19470, 'M3'], ['五', '連續壁工程', 15550, 'M2'], ['六', '鑽掘混凝土基樁工程', 6315, 'M'], ['七', '營建剩餘資源處理工程', 192575, 'M3'], ['八', '模板組立工程', 93026, 'M2'], ['九', '鋼筋工程', 11038, 'T'], ['十', '預拌混凝土工程', 50299, 'M3'], ['十一', '接地系統工程', 1, '式'], ['十二', '政大宿舍拆除工程', 1, '式'], ['十三', '舊廣路銅橋橋新建（含拆除）工程', 1, '式'], ['十四', '臨時排水工程', 1, '式'], ['十五', '地下調查工程', 1, '式']];
    sw.forEach((s, i) => out.subworks.push({ id: 'S671-' + (i + 1), tenderId: 'T671', no: s[0], name: s[1], qty: s[2], unit: s[3], status: '施工中', order: i }));
    [['隧道（地下）工程', 4], ['車站工程', 23]].forEach((s, i) => out.subworks.push({ id: 'S624-' + (i + 1), tenderId: 'T624', no: ['一', '二'][i], name: s[0], qty: 1, unit: '式', status: '施工中', order: i }));

    // 範本
    const t55 = { id: 'TP-5-5', tenderId: 'T671', subworkId: 'S671-5', kind: 'self', code: '5-5', name: '連續壁施工自主檢查表', version: 1, status: 'published', source: 'CF671-PL-0032 Y01站連續壁工計畫書 第5章 品質管理（p.5-10~5-11）', fillMode: 'online', items: items55(), used: 2 };
    const spotItems = items55().map(i => { i.srcNo = i.no; i.hold = [4, 8, 9, 10, 11, 12, 16].includes(i.no); return i; });
    const tSpot = { id: 'TP-SP-1', tenderId: 'T671', subworkId: 'S671-5', kind: 'spot', code: 'SP-5', name: '連續壁施工品質抽查記錄表', version: 1, status: 'published', source: 'CF671-PL-0032 連續壁工計畫書 p.5-20~5-21', pairedSelf: 'TP-5-5', fillMode: 'online', items: spotItems, used: 1 };
    out.templates.push(t55, tSpot);
    out.templates.push(mini('TP-5-4', 'S671-5', 'self', '5-4', '導溝施工自主檢查表', 5), mini('TP-5-6', 'S671-5', 'self', '5-6', '鋼筋籠自主檢查表', 6), pdfTpl('TP-5-7', 'S671-5', 'self', '5-7', '穩定液自主檢查紀錄表', '穩定液自主檢查紀錄表_空白範本.pdf'), mini('TP-5-8', 'S671-5', 'self', '5-8', '連續壁超音波檢測紀錄表', 4), mini('TP-5-9', 'S671-5', 'self', '5-9', '連續壁混凝土灌漿紀錄表', 4));
    out.templates.push(mini('TP-SP-2', 'S671-5', 'spot', 'SP-6', '連續壁鋼筋籠施工品質抽查記錄表', 5), pdfTpl('TP-SP-3', 'S671-5', 'spot', 'SP-7', '連續壁穩定液施工品質抽查記錄表', '連續壁穩定液施工品質抽查記錄表_空白範本.pdf'), mini('TP-SP-0', 'S671-5', 'spot', 'SP-4', '導溝施工品質抽查記錄表', 5));
    [[1, '鋼板樁'], [2, '開挖支撐'], [6, '鑽掘混凝土基樁'], [8, '模板組立'], [9, '鋼筋'], [10, '預拌混凝土']].forEach(([n, nm]) => out.templates.push(mini('TP-S' + n, 'S671-' + n, 'self', '1-' + n, nm + '自主檢查表', 4)));
    out.templates.find(t => t.id === 'TP-S2').used = 2;

    // 參考文件
    [['CF671-PL-0032', 'Y01 站連續壁工計畫書', '第5章 品質管理（p.5-10~5-21）'], ['CF671-DW-0101', '連續壁施工圖', 'Y01 站 單元配置'], ['CF671-SP-0005', '施工規範 03310 混凝土', '坍度、溫度及試體規定'], ['CF671-SP-0007', '施工規範 02450 連續壁', '垂直度及穩定液管理']].forEach(d => out.docs.push({ id: d[0], code: d[0], name: d[1], note: d[2], projKey: 'CF670A' }));
    out.users.push(
      { id: 'U1', name: '系統管理員', role: '系統管理員', org: '第二區工程處', email: 'admin@example.com' },
      { id: 'U2', name: '示範品管', role: '廠商品管人員', org: '大陸工程股份有限公司', email: 'qc@contractor.example.com' },
      { id: 'U3', name: '示範工地主任', role: '工地授權代表', org: '大陸工程股份有限公司', email: 'lead@contractor.example.com' },
      { id: 'U4', name: '示範工務所同仁', role: '捷運局工務所同仁', org: '捷運局工務所', email: 'sv@supervisor.example.com' },
      { id: 'U5', name: '示範工務所主任', role: '捷運局工務所主任', org: '捷運局工務所', email: 'chief@supervisor.example.com' }
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
      id: 'HP-CF671-1004-003', tenderId: 'T671', tenderCode: 'CF671', subworkId: 'S671-5', scId: sc.id, itemNo: 10, title: '鋼筋籠吊放高程及位置確認', subworkName: '連續壁工程', checkName: '表5-5 連續壁施工自主檢查表', location: 'Y01站 單元 P12（公單元）', unit: 'P12',
      appliedAt: A, replyDue: A + 8 * H, scheduledAt: A + 18 * H, applicant: '大陸工程 品管人員', status: 'pending', shortNotice: true, shortReason: '配合混凝土車預約時段，需於明早吊放完成。', inspector: '', photoCount: 3,
      std: '壁體垂直方向偏差 25mm\n其他方向 75mm\n鋼筋籠頂高程 EL 122.9m', values: { dv: 18, do: 40, el: 122.91 },
      notices: [{ at: A, text: '廠商送出會驗申請（附照片 3 張）', level: 'info' }, { at: A, text: 'Email 已寄送監造人員（2 位）', level: 'info' }]
    });
    const mkReq = (id, title, loc, applied, sched, status, sw) => ({ id, tenderId: 'T671', tenderCode: 'CF671', subworkId: 'S671-5', scId: '', itemNo: 0, title, subworkName: sw || '連續壁工程', checkName: '', location: loc, unit: '', appliedAt: applied, replyDue: applied + 8 * H, scheduledAt: sched, applicant: '大陸工程 品管人員', status, shortNotice: false, shortReason: '', inspector: status === 'pending' ? '' : '示範工務所同仁', photoCount: 2, std: '依施工圖及規範', values: {}, notices: [{ at: applied, text: '廠商送出會驗申請', level: 'info' }, { at: applied, text: 'Email 已寄送監造人員（2 位）', level: 'info' }] });
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
    const mkSpot = (id, reqId, focus, judge, loc, unit, when) => {
      const tp = out.templates.find(t => t.id === 'TP-SP-1'), ans = {};
      tp.items.forEach(i => { ans[i.no] = { judge: i.no === focus ? judge : 'na', values: {}, photos: [], note: '' }; });
      return { id, kind: 'hold', requestId: reqId, scId: '', itemNo: focus, focusNo: focus, templateId: tp.id, templateVer: 1, templateName: tp.name, subworkId: 'S671-5', tenderId: 'T671', tenderCode: 'CF671', unit, location: loc, title: tp.items.find(i => i.no === focus).name, answers: ans, calc: { thickness: '1.0', length: '6.0', depth: '32' }, status: 'signed', signatures: {}, hash: 'seeddemo', date: when, createdAt: when };
    };
    out.spotChecks.push(mkSpot('SP-CF671-1002-001', 'HP-CF671-1002-001', 8, 'ok', 'Y01站 單元 P12', 'P12', now - 2 * D), mkSpot('SP-CF671-0930-001', 'HP-CF671-0929-001', 8, 'ng', 'Y01站 單元 P10', 'P10', now - 7 * D));
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

  /* ---------- 標案（來源：標案管理系統 ProjBase） ---------- */
  const STEP_TEXT = { A: '未開工', B: '施工中', C: '驗收中', D: '保固', E: '結案', F: '仲裁中', Z: '解約' };
  const PROJ_TYPE_TEXT = { '區': '區段標', '子': '子標', '單': '單一標' };
  // 後台身份（部門）：部門代碼對應 ProjBase 的 WORK_SECTION_ID
  const DEPTS = [{ id: '2J', name: '二區工程處土十所' }, { id: '2B', name: '二區工程處土十一所' }, { id: '2F', name: '二區工程處水環二所' }];
  const rocDate = v => /^\d{7}$/.test(v || '') ? `${v.slice(0, 3)}/${v.slice(3, 5)}/${v.slice(5)}` : '';
  const office = name => { const m = String(name || '').match(/^(.*?工程處)/); return '臺北市政府捷運工程局' + (m ? m[1] : ''); };
  // 由 ProjBase 資料列建立系統內的標案（子標需帶入上層區段標）
  function tenderFromProj(r, up) {
    return { id: 'T-' + r.PROJ_ID, code: r.PROJ_ID, name: r.PROJ_NAME_C, type: r.PROJ_TYPE, parentCode: up ? up.PROJ_ID : '', parentName: up ? up.PROJ_NAME_C : '', parentSectionId: up ? up.WORK_SECTION_ID : '',
      contId: r.CONT_ID || '', line: r.LINE_NM || '', contractor: (r.CONT_COMP_NAME_C || '').trim(), sectionId: r.WORK_SECTION_ID || '', sectionName: r.WORK_SECTION_NAME || '', supervisor: office(r.WORK_SECTION_NAME),
      site: String(r.WORK_LOCA || '').replace(/\s+/g, ' ').trim(), start: rocDate(r.ACTU_STAR_DATE), end: rocDate(r.PLAN_FINI_DATE), amount: r.CONT_AMT_NT || 0, step: r.STEP_TYPE || '', status: STEP_TEXT[r.STEP_TYPE] || '—', desc: '', members: 0, src: 'projbase', addedAt: Date.now() };
  }
  // 畫面用的短名稱：去掉共同前綴「臺北都會區大眾捷運系統」與「…區段標-」
  function tLabel(t) { if (!t) return ''; const n0 = String(t.name || ''); let n = n0.replace(/^臺北都會區大眾捷運系統/, '').replace(/^.*?區段標\s*[-－]?\s*/, '').replace(new RegExp('^' + String(t.code || '#').replace(/[^\w]/g, '') + '(施工標|標)?\\s*[-－]?\\s*'), '').trim(); return `${t.code} ${n || n0}`.trim(); }
  // 區段標／單一標鍵值：子標取上層區段標，單一標取本身標號
  // 標案排序：區段標群組（有區段標者在前，依區段標代號）→ 同群組依「標案架構」拖曳順序(order)→ 代號
  function sortTenders(list) {
    return (list || []).slice().sort((a, b) => { const ka = a.parentCode || '', kb = b.parentCode || '';
      return (ka ? 0 : 1) - (kb ? 0 : 1) || ka.localeCompare(kb) || (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order) || String(a.code).localeCompare(String(b.code)); });
  }
  const projKey = t => t ? (t.parentCode || t.code || '') : '';
  function projOptions(tenders) { const m = new Map(); (tenders || []).slice().sort((a, b) => projKey(a).localeCompare(projKey(b))).forEach(t => { const k = projKey(t); if (k && !m.has(k)) m.set(k, { v: k, l: `${k} ${t.parentCode ? '區段標' : '單一標'}`, name: t.parentCode ? t.parentName : t.name }); }); return [...m.values()]; }
  // 部門可見：標案本身或其區段標屬於該部門
  const tenderInDept = (t, dept) => !dept || t.sectionId === dept || t.parentSectionId === dept;
  const SEED_PROJ = {
    CF670A: { PROJ_TYPE: '區', PROJ_ID: 'CF670A', PROJ_NAME_C: '臺北都會區大眾捷運系統環狀線南環段CF670A區段標工程', CONT_ID: 'E1366-1122006-000', LINE_NM: '環狀線南環及北環', CONT_AMT_NT: 8838099353, ACTU_STAR_DATE: '1120613', PLAN_FINI_DATE: '1220710', WORK_LOCA: '臺北市文山區新光路2段經秀明路2段至木新路', WORK_SECTION_ID: '2J', WORK_SECTION_NAME: '第二區工程處土木第十工務所', CONT_COMP_NAME_C: '大陸工程股份有限公司', STEP_TYPE: 'B' },
    CF671: { PROJ_TYPE: '子', PROJ_UP: 'CF670A', PROJ_ID: 'CF671', PROJ_NAME_C: '環狀線南環段Y1站(含)~Y2A站(不含)土建工程', CONT_ID: 'E1366-1122006-000', LINE_NM: '環狀線南環及北環', CONT_AMT_NT: 7645834674, ACTU_STAR_DATE: '1120613', PLAN_FINI_DATE: '1210410', WORK_LOCA: '臺北市文山區新光路2段經秀明路2段至木新路', WORK_SECTION_ID: '2J', WORK_SECTION_NAME: '第二區工程處土木第十工務所', CONT_COMP_NAME_C: '大陸工程股份有限公司', STEP_TYPE: 'B' },
    CF624H: { PROJ_TYPE: '子', PROJ_UP: 'CF670A', PROJ_ID: 'CF624H', PROJ_NAME_C: '臺北都會區大眾捷運系統環狀線南環段CF670A區段標-CF624H水電環控工程', CONT_ID: 'E1366-1122006-000', LINE_NM: '環狀線南環及北環', CONT_AMT_NT: 1192264679, ACTU_STAR_DATE: '1120613', PLAN_FINI_DATE: '1220710', WORK_LOCA: '臺北市文山區   動物園(Y01)站至政大(Y1A)站', WORK_SECTION_ID: '2F', WORK_SECTION_NAME: '第二區工程處水環第二工務所', CONT_COMP_NAME_C: '大陸工程股份有限公司', STEP_TYPE: 'B' }
  };
  // 舊示範標案（自行輸入的資料）改為與 ProjBase 一致；紀錄上的承包商一併更正
  // 參考文件以區段標／單一標為鍵值：舊資料歸到 CF670A
  async function migrateDocs() { for (const x of (await all('docs')).filter(x => !x.projKey)) { x.projKey = 'CF670A'; await put('docs', x); } }
  async function migrateTenders() {
    for (const [id, code] of [['T671', 'CF671'], ['T624', 'CF624H']]) {
      const t = await get('tenders', id); if (!t || t.src) continue;
      const n = Object.assign(tenderFromProj(SEED_PROJ[code], SEED_PROJ.CF670A), { id, members: t.members || 0, addedAt: 0 }); await put('tenders', n);
      for (const st of ['selfChecks', 'spotChecks']) for (const r of (await all(st)).filter(x => x.tenderId === id && x.contractor && x.contractor !== n.contractor)) { r.contractor = n.contractor; await put(st, r); }
    }
  }
  /* ---------- 初始化與重置 ---------- */
  async function seed(force) {
    if (!force && await get('meta', 'seeded')) return;
    if (force) await clearAll();
    const d = buildSeed();
    for (const s of Object.keys(d)) await putMany(s, d[s]);
    await put('meta', { id: 'seeded', at: Date.now() });
    if (force) await postSeed();
  }
  /* ---------- 項目永久代碼（key）：範本改版、項次重排後，抽查表仍能對應到正確的自檢項目 ---------- */
  const baseId = id => String(id).replace(/-v\d+$/, '');
  function ensureKeys(tpl) { (tpl.items || []).forEach(i => { if (!i.key) i.key = uid('K'); }); return tpl; }
  async function migrateKeys() {
    const tpls = await all('templates'), byId = Object.fromEntries(tpls.map(t => [t.id, t]));
    for (const t of tpls) {
      let ch = false;
      (t.items || []).forEach(i => { if (!i.key) { i.key = baseId(t.id) + '#' + i.no; ch = true; } });
      if (t.kind === 'spot' && t.pairedSelf && byId[t.pairedSelf]) {
        const ps = byId[t.pairedSelf];
        t.items.forEach(i => { if (i.srcNo && !i.srcKey) { const si = ps.items.find(x => x.no === i.srcNo); if (si) { i.srcKey = si.key || baseId(ps.id) + '#' + si.no; ch = true; } } });
      }
      if (ch) await put('templates', t);
    }
    for (const r of await all('requests')) {
      if (r.itemKey || !r.scId || !r.itemNo) continue;
      const sc = await get('selfChecks', r.scId), tpl = sc && await get('templates', sc.templateId), it = tpl && tpl.items.find(i => i.no === r.itemNo);
      if (it && it.key) { r.itemKey = it.key; await put('requests', r); }
    }
  }
  // 自檢表的關聯子表單（表5-4、5-6、5-7）建立真實紀錄，取代「手動標記完成」
  async function seedLinked() {
    if (await get('meta', 'linkSeed')) return;
    const now = Date.now();
    for (const [unit, loc, ago] of [['P11', 'Y01站 單元 P11（母單元）', 6 * D], ['P12', 'Y01站 單元 P12（公單元）', 11 * H]]) {
      for (const code of ['5-4', '5-6', '5-7']) {
        const tpl = (await all('templates')).find(t => t.code === code && t.kind === 'self' && t.status === 'published'); if (!tpl) continue;
        if ((await all('selfChecks')).some(s => s.unit === unit && s.templateCode === code)) continue;
        const at = now - ago, ans = {}; tpl.items.forEach(i => { ans[i.no] = { judge: 'ok', values: {}, photos: [], note: '' }; });
        const rec = { id: `SC-CF671-LNK-${unit}-${code}`, tenderId: 'T671', tenderCode: 'CF671', templateId: tpl.id, templateVer: tpl.version, templateCode: code, templateName: tpl.name, subworkId: tpl.subworkId, subworkName: 'Y01站連續壁施工', unit, location: loc, date: at, contractor: '大陸工程股份有限公司', status: 'signed', answers: ans, linked: {}, qrConfirmed: true, drawingNo: '', hold: {}, recovery: '', signatures: { site: { img: '', at, name: '示範品管' }, rep: { img: '', at, name: '示範工地主任' } }, hash: 'linkseed', createdAt: at, updatedAt: at, fillMode: tpl.fillMode || 'online', pdfFile: null, wfStatus: '未開始', lockedBy: null, lastUpdatedBy: null, version: 0, logs: [] };
        if (tpl.fillMode === 'pdf' && tpl.pdf) {
          const f = { name: `${tpl.name}_${unit}_已填寫.pdf`, size: tpl.pdf.size, data: tpl.pdf.data, at };
          Object.assign(rec, { answers: {}, pdfFile: f, wfStatus: '已結案', version: 2, lastUpdatedBy: '示範品管', logs: [{ at: at - 3600e3, user: '示範品管', action: '下載鎖定', detail: '下載空白範本並鎖定控制權，開始填寫表單。' }, { at: at - 1800e3, user: '示範品管', action: '上傳並簽名', detail: '已完成 PDF 上傳並現地手寫簽名，待辦理憑證加簽結案。', file: { name: f.name, size: f.size, data: f.data } }, { at, user: '示範品管', action: '憑證加簽結案', detail: '經實體自然人憑證數位簽章認證，表單正式結案。', file: { name: f.name, size: f.size, data: f.data } }] });
        }
        await put('selfChecks', rec);
      }
    }
    await put('meta', { id: 'linkSeed', at: now });
  }
  function mailNotice(users) { return users.length ? { at: Date.now(), text: `Email 已寄送捷運局工務所人員（${users.length} 位：${users.map(u => u.name).join('、')}）`, level: 'info' } : { at: Date.now(), text: '尚未設定捷運局工務所人員帳號，Email 未寄出', level: 'warn' }; }
  // 舊資料：會驗申請補上 subworkId（依自檢表或分項工程名稱對應）
  async function migrateReqSub() {
    const subs = await all('subworks');
    for (const r of await all('requests')) {
      if (r.subworkId) continue; const sc = r.scId ? await get('selfChecks', r.scId) : null;
      const sw = sc ? { id: sc.subworkId } : subs.find(s => s.tenderId === r.tenderId && s.name === r.subworkName) || (r.tenderId === 'T671' && /導溝|鋼筋籠|連續壁|穩定液/.test(r.subworkName + r.title) ? { id: 'S671-5' } : null);
      if (sw) { r.subworkId = sw.id; await put('requests', r); }
    }
  }
  // 舊資料：會驗申請／抽查紀錄補上對應的自主檢查表（依停留點的申請編號，或同分項工程＋同單元）
  async function migrateScLinks() {
    const scs = await all('selfChecks');
    for (const r of await all('requests')) {
      if (r.scId) continue; const sc = scs.find(s => Object.entries(s.hold || {}).some(([, h]) => h.requestId === r.id));
      if (sc) { r.scId = sc.id; r.itemNo = r.itemNo || Number(Object.entries(sc.hold).find(([, h]) => h.requestId === r.id)[0]); await put('requests', r); }
    }
    const reqs = await all('requests');
    for (const sp of await all('spotChecks')) {
      if (sp.scId) continue; const r = sp.requestId && reqs.find(x => x.id === sp.requestId);
      const sc = (r && r.scId && scs.find(s => s.id === r.scId)) || scs.filter(s => s.unit === sp.unit && s.subworkId === sp.subworkId).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (sc) { sp.scId = sc.id; await put('spotChecks', sp); }
    }
  }
  async function postSeed() { await migrateKeys(); await migrateReqSub(); await migrateScLinks(); await seedLinked(); await migrateUnits(); await migrateUnitsWall(); }
  // 單元示範資料：鑽掘混凝土基樁（S671-6）設定 BP-01、BP-02 兩個單元，各掛自己的表單範本
  async function migrateUnits() {
    const sw = await get('subworks', 'S671-6'); if (!sw || 'unitList' in sw) return;
    sw.unitList = ['BP-01', 'BP-02']; await put('subworks', sw);
    const t = await get('templates', 'TP-S6'); if (t && !t.unitNo) { t.unitNo = 'BP-01'; await put('templates', t); }
    const add = [mini('TP-S6-2', 'S671-6', 'self', '1-6-2', '鑽掘混凝土基樁自主檢查表（BP-02）', 4, { unitNo: 'BP-02' }), mini('TP-SP-S6', 'S671-6', 'spot', 'SP-1-6', '鑽掘混凝土基樁施工品質抽查記錄表', 4, { unitNo: 'BP-01' })];
    for (const x of add) if (!(await get('templates', x.id))) await put('templates', ensureKeys(x));
  }
  // 單元示範資料：CF671「五、連續壁工程」設定 P11、P12、P13 三個單元，檢查表／抽查紀錄表只掛在單元下（分項工程層不掛）
  // P12 沿用原範本代碼與紀錄；P11、P13 複製一份（代碼加單元尾碼），已有紀錄的 templateId 一併對應到該單元的範本
  async function migrateUnitsWall() {
    const sw = await get('subworks', 'S671-5'); if (!sw) return;
    const tpls = (await all('templates')).filter(t => t.subworkId === 'S671-5');
    if (tpls.some(t => t.unitNo)) return; // 已是單元層級
    const units = ['P11', 'P12', 'P13'], main = 'P12';
    sw.unitList = units; await put('subworks', sw);
    const ids = new Set(tpls.map(t => t.id));
    for (const t of tpls) {
      t.unitNo = main; await put('templates', t);
      for (const u of units.filter(x => x !== main)) {
        const c = clone(t); c.id = `${t.id}-${u}`; c.unitNo = u; c.used = 0; if (c.pairedSelf) c.pairedSelf = `${c.pairedSelf}-${u}`;
        if (!(await get('templates', c.id))) await put('templates', c);
      }
    }
    for (const store of ['selfChecks', 'spotChecks']) {
      for (const r of await all(store)) {
        if (r.subworkId === 'S671-5' && units.includes(r.unit) && r.unit !== main && ids.has(r.templateId)) { r.templateId = `${r.templateId}-${r.unit}`; await put(store, r); }
      }
    }
  }
  // 舊版抽查紀錄（單項 measures/judge）轉為完整表單結構
  async function migrateSpots() {
    const list = (await all('spotChecks')).filter(x => !x.answers); if (!list.length) return;
    for (const sp of list) {
      const tpl = await get('templates', sp.templateId || 'TP-SP-1'); if (!tpl) continue;
      const focus = (tpl.items.find(i => i.srcNo === sp.itemNo) || {}).no || null, ans = {};
      tpl.items.forEach(i => { ans[i.no] = { judge: sp.status === 'signed' ? 'na' : null, values: {}, photos: [], note: '' }; });
      if (focus) ans[focus] = { judge: sp.judge || null, values: sp.measures || {}, photos: sp.photos || [], note: '' };
      Object.assign(sp, { kind: sp.requestId ? 'hold' : 'random', focusNo: focus, templateVer: tpl.version, templateName: tpl.name, answers: ans, date: sp.date || sp.createdAt });
      delete sp.measures; delete sp.judge; delete sp.photos; await put('spotChecks', sp);
    }
  }
  // 舊版角色名稱「監造…」改為「捷運局工務所…」
  async function migrateRoles() {
    const R = { '監造現場工程師': '捷運局工務所同仁', '監造工務所主任': '捷運局工務所主任' };
    for (const u of await all('users')) {
      if (R[u.role] || u.org === '監造工務所' || u.name === '示範監造') { u.role = R[u.role] || u.role; if (u.org === '監造工務所') u.org = '捷運局工務所'; if (u.name === '示範監造') u.name = '示範工務所同仁'; await put('users', u); }
    }
    for (const r of await all('requests')) if (r.inspector === '示範監造') { r.inspector = '示範工務所同仁'; await put('requests', r); }
  }
  const ready = open().then(() => seed(false)).then(() => migrateTenders()).then(() => migrateDocs()).then(() => migrateRoles()).then(() => migrateSpots()).then(() => migratePdfWf()).then(() => postSeed()).then(() => tickOverdue());

  async function getParams() { return Object.assign({}, DEFAULT_PARAMS, await get('meta', 'params') || {}); }
  async function counter(name) {
    const c = (await get('meta', 'counter')) || { id: 'counter' };
    c[name] = (c[name] || 0) + 1; await put('meta', c); return c[name];
  }

  /* ---------- 業務流程 ---------- */
  // 逾時回覆：寄提醒並往上通知主管（只記錄一次）
  async function tickOverdue() {
    const now = Date.now(); const reqs = await all('requests');
    const bosses = (await all('users')).filter(u => u.role === '捷運局工務所主任').map(u => u.name);
    for (const r of reqs) {
      if (r.status === 'pending' && now > r.replyDue && !r.overdueNotified) {
        r.overdueNotified = true;
        r.notices.push({ at: r.replyDue, text: '回覆期限到期，寄出逾時提醒 Email', level: 'warn' });
        r.notices.push({ at: r.replyDue + 3600e3 > now ? now : r.replyDue + 3600e3, text: bosses.length ? `逾時未回覆，往上通知主管（${bosses.join('、')}）` : '逾時未回覆，但尚未設定「捷運局工務所主任」帳號，無法往上通知', level: 'danger' });
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
      subworkId: sw.id, subworkName: sw.name, unit: unit || '', location: location || `${tender.site || tender.name} ${unit ? '單元 ' + unit : sw.name}`, date: Date.now(), contractor: tender.contractor,
      status: 'draft', answers: {}, linked: {}, qrConfirmed: false, drawingNo: drawingNo || '', hold: {}, recovery: '', signatures: {}, createdAt: Date.now(), updatedAt: Date.now(),
      fillMode: tpl.fillMode || 'online', pdfFile: null,
      wfStatus: '未開始', lockedBy: null, lastUpdatedBy: null, version: 0, logs: []
    };
    await put('selfChecks', sc); return sc;
  }
  async function saveSelf(sc) { sc.updatedAt = Date.now(); return put('selfChecks', sc); }

  async function applyHold(scId, itemNo, { scheduledAt, reason, location, applicant }) {
    const sc = await get('selfChecks', scId), tpl = await get('templates', sc.templateId), it = tpl.items.find(i => i.no === itemNo), p = await getParams();
    const sups = (await all('users')).filter(u => /工務所/.test(u.role));
    const now = Date.now(), short = (scheduledAt - now) < p.holdAdvanceHours * H;
    if (short && !(reason || '').trim()) throw new Error(`距預定會驗不足 ${p.holdAdvanceHours} 小時，請填寫原因`);
    const n = await counter('req'); const d = new Date();
    const a = sc.answers[itemNo] || { values: {}, photos: [] };
    const req = {
      id: `HP-${sc.tenderCode}-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(n, 3)}`, tenderId: sc.tenderId, tenderCode: sc.tenderCode, scId, itemNo, itemKey: it.key || '', title: it.name,
      subworkName: sc.subworkName, checkName: `表${sc.templateCode} ${sc.templateName}`, location: location || sc.location, unit: sc.unit, appliedAt: now, replyDue: now + p.replyHours * H, scheduledAt,
      subworkId: sc.subworkId, applicant: applicant || sc.contractor || '施工廠商', status: 'pending', shortNotice: short, shortReason: short ? reason : '', inspector: '', photoCount: (a.photos || []).length, std: it.std, values: clone(a.values || {}),
      notices: [{ at: now, text: `廠商送出會驗申請（附照片 ${(a.photos || []).length} 張）`, level: 'info' }, mailNotice(sups)]
    };
    sc.hold[itemNo] = { state: 'applied', requestId: req.id };
    await put('requests', req); await saveSelf(sc); return req;
  }
  async function syncHold(req, state) {
    if (!req.scId) return;
    const sc = await get('selfChecks', req.scId); if (!sc) return;
    if (sc.status === 'signed') return; // 已簽認鎖定的表單不再回寫（避免與簽認雜湊不符）
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
    r.status = 'rejected'; r.rejectReason = reason || '（未填原因）'; r.rejectedAt = Date.now(); r.notices.push({ at: Date.now(), text: `監造退回申請：${r.rejectReason}`, level: 'danger' });
    await put('requests', r); await syncHold(r, 'none'); return r;
  }
  // 建立抽查紀錄（會驗或隨機抽查）。focus = 本次會驗的檢查項目(對應自主檢查表項次)
  async function newSpotCheck({ templateId, unit, location, request, selfCheckId }) {
    const tpl = await get('templates', templateId), n = await counter('spot'), d = new Date();
    const tender = await get('tenders', tpl.tenderId); const sw = await get('subworks', tpl.subworkId);
    let sc = selfCheckId ? await get('selfChecks', selfCheckId) : null;
    // 廠商自檢對照：有單元＝同分項工程＋同單元；沒有單元＝同分項工程（有配對自檢表時優先同表）
    if (!sc && (unit || !request)) { const pair = tpl.pairedSelf ? await get('templates', tpl.pairedSelf) : null; const l = (await all('selfChecks')).filter(x => x.subworkId === tpl.subworkId && (x.unit || '') === (unit || '')).sort((a, b) => (pair ? (b.templateCode === pair.code) - (a.templateCode === pair.code) : 0) || b.createdAt - a.createdAt); sc = l[0] || null; }
    const focus = request && request.itemNo ? (tpl.items.find(i => request.itemKey && i.srcKey === request.itemKey) || tpl.items.find(i => !request.itemKey && i.srcNo === request.itemNo) || {}).no || null : null;
    const answers = {}; tpl.items.forEach(i => { answers[i.no] = { judge: null, values: {}, photos: [], note: '' }; });
    const sp = {
      id: `SP-${tender.code}-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(n, 3)}`, kind: request ? 'hold' : 'random', requestId: request ? request.id : '', scId: sc ? sc.id : '', itemNo: request ? request.itemNo : 0, focusNo: focus,
      templateId: tpl.id, templateVer: tpl.version, templateName: tpl.name, subworkId: tpl.subworkId, tenderId: tender.id, tenderCode: tender.code, unit: unit || (request && request.unit) || '', location: location || (request && request.location) || (sc && sc.location) || (unit ? `單元 ${unit}` : (sw ? sw.name : '')),
      title: focus ? tpl.items.find(i => i.no === focus).name : (request ? request.title : tpl.name), subworkName: sw ? sw.name : '', answers,
      calc: { thickness: '1.0', length: sc && sc.answers[2] ? String((sc.answers[2].values || {}).len || '') : '', depth: '' }, status: 'draft', signatures: {}, date: Date.now(), createdAt: Date.now(),
      fillMode: tpl.fillMode || 'online', pdfFile: null,
      wfStatus: '未開始', lockedBy: null, lastUpdatedBy: null, version: 0, logs: []
    };
    await put('spotChecks', sp); return sp;
  }
  // 會驗可用的抽查紀錄表：同分項工程已發布者；預設為含本停留點對應項目的線上抽查表
  async function spotOptions(reqId) {
    const r = await get('requests', reqId), sc = r.scId ? await get('selfChecks', r.scId) : null, sub = (sc && sc.subworkId) || r.subworkId;
    let tpls = (await all('templates')).filter(t => t.kind === 'spot' && t.status === 'published' && t.subworkId === sub && t.fillMode !== 'pdf');
    const unit = (sc && sc.unit) || r.unit || ((String(r.location || '').match(/單元\s*([A-Za-z0-9-]+)/) || [])[1] || ''), byUnit = tpls.filter(t => (t.unitNo || '') === unit), lvl = tpls.filter(t => !t.unitNo);
    tpls = (byUnit.length ? byUnit : lvl.length ? lvl : tpls).sort((a, b) => (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order));
    const def = (r.itemKey && tpls.find(t => t.items.some(i => i.srcKey === r.itemKey))) || tpls.find(t => t.items.some(i => i.srcNo === r.itemNo)) || tpls[0] || null;
    return { tpls, def };
  }
  async function startInspection(reqId, templateId) {
    const r = await get('requests', reqId);
    if (r.spotId) return get('spotChecks', r.spotId);
    const { tpls, def } = await spotOptions(reqId);
    if (!tpls.length) throw new Error(`「${r.subworkName || '此分項工程'}」尚未設定已發布的線上抽查紀錄表範本（停留點會驗不可使用 PDF 抽查表），請先至後台「表單範本」建立`);
    const tpl = (templateId && tpls.find(t => t.id === templateId)) || def;
    const sp = await newSpotCheck({ templateId: tpl.id, unit: r.unit, location: r.location, request: r, selfCheckId: r.scId });
    r.status = 'inspecting'; r.spotId = sp.id; r.notices.push({ at: Date.now(), text: '監造開始會驗', level: 'info' });
    await put('requests', r); return sp;
  }
  // 取消會驗：「檢驗中」回到「已排定」，未簽認的抽查紀錄草稿作廢
  async function cancelInspection(reqId, reason, user) {
    const r = await get('requests', reqId); if (r.status !== 'inspecting') throw new Error('只有「檢驗中」的會驗可以取消');
    if (!(reason || '').trim()) throw new Error('請填寫取消原因');
    if (r.spotId) { const sp = await get('spotChecks', r.spotId); if (sp && sp.status === 'signed') throw new Error('抽查紀錄已簽認，不可取消'); if (sp) await del('spotChecks', sp.id); }
    r.status = 'scheduled'; r.spotId = null;
    r.notices.push({ at: Date.now(), text: `${user || '監造'}取消會驗：${reason.trim()}（抽查紀錄草稿已作廢，可改期或重新開始會驗）`, level: 'warn' });
    await put('requests', r); await syncHold(r, 'scheduled'); return r;
  }
  async function createDefect({ tenderCode, title, location, source, refId, itemNo, subworkId, scId, scItemNo }) {
    const n = await counter('defect'), p = await getParams(), now = Date.now(), tender = (await all('tenders')).find(t => t.code === tenderCode);
    const df = { id: 'DF-' + pad(n, 4), tenderId: tender ? tender.id : '', tenderCode, title, location, source, refId, itemNo, subworkId: subworkId || '', scId: scId || '', scItemNo: scItemNo || 0, createdAt: now, due: now + p.defectDueDays * D, status: 'open', note: '', history: [{ at: now, text: `由「${source}」判定缺失，自動建立（改善期限 ${p.defectDueDays} 天）` }] };
    await put('defects', df); return df;
  }
  // 自主檢查表兩位簽認完成後鎖定
  async function finalizeSelf(scId) {
    const sc = await get('selfChecks', scId); const tpl = await get('templates', sc.templateId);
    sc.hash = await hashOf({ a: sc.answers, l: sc.linked, h: sc.hold, r: sc.recovery, t: sc.templateId, v: sc.templateVer });
    sc.status = 'signed'; await saveSelf(sc);
    for (const it of tpl.items) {
      const a = sc.answers[it.no] || {};
      if (a.judge === 'ng' && !a.defectId) {
        const df = await createDefect({ tenderCode: sc.tenderCode, title: it.name, location: `${sc.tenderCode}｜${sc.subworkName} ${sc.unit}`, source: '自主檢查', refId: sc.id, itemNo: it.no, subworkId: sc.subworkId, scId: sc.id, scItemNo: it.no });
        // 自檢表已勾選「已完成改善」：缺失直接進入「待複查」，不需廠商再回報一次
        if (sc.recovery === 'done') { df.status = 'review'; df.fix = { note: '廠商於自主檢查表勾選「已完成改善」', photos: (a.photos || []).slice(0, 6), at: Date.now(), by: (sc.signatures.site || {}).name || '廠商' }; df.history = [{ at: Date.now(), text: '自主檢查表勾選「已完成改善」，轉待複查' }]; await put('defects', df); }
      }
    }
    return sc;
  }
  // 未抽查項目自動填 ╱
  function autoNa(sp) { Object.values(sp.answers).forEach(a => { if (!a.judge) a.judge = 'na'; }); }
  async function finalizeSpot(spId) {
    const sp = await get('spotChecks', spId); const tpl = await get('templates', sp.templateId);
    const isPdf = sp.fillMode === 'pdf';
    if (!isPdf) autoNa(sp);
    sp.hash = await hashOf({ a: sp.answers, c: sp.calc, v: sp.templateVer, p: sp.pdfFile ? [sp.pdfFile.name, sp.pdfFile.size] : null });
    sp.status = 'signed'; await put('spotChecks', sp);
    const ngItems = isPdf ? [] : tpl.items.filter(i => (sp.answers[i.no] || {}).judge === 'ng');
    const scItem = it => (it.no === sp.focusNo ? sp.itemNo : 0);
    for (const it of ngItems) await createDefect({ tenderCode: sp.tenderCode, title: it.name, location: `${sp.tenderCode}｜${sp.location}`, source: '抽查', refId: sp.id, itemNo: it.no, subworkId: sp.subworkId, scId: sp.scId, scItemNo: scItem(it) });
    if (sp.requestId) {
      const r = await get('requests', sp.requestId);
      const pass = isPdf ? true : (sp.focusNo ? sp.answers[sp.focusNo].judge !== 'ng' : !ngItems.length);
      r.status = pass ? 'passed' : 'failed';
      r.notices.push({ at: Date.now(), text: pass ? '抽查完成，合格放行（後續項目解鎖）' : '抽查判定有缺失，不合格', level: pass ? 'ok' : 'danger' });
      await put('requests', r); await syncHold(r, pass ? 'passed' : 'failed');
      // 停留點會驗合格 = 完成缺失複查：同一張自檢表、同一停留點的未結案缺失自動結案
      if (pass && r.scId) for (const df of (await all('defects')).filter(x => x.scId === r.scId && x.scItemNo === r.itemNo && x.status !== 'closed')) {
        df.status = 'closed'; df.closedAt = Date.now(); df.note = `經停留點會驗（${sp.id}）合格，自動結案`; (df.history = df.history || []).push({ at: Date.now(), text: df.note }); await put('defects', df);
      }
    }
    return sp;
  }
  /* ---------- PDF 範本工作流程：下載鎖定 → 上傳續填 → 現地手寫簽名 → 憑證加簽結案 ----------
   * 狀態：未開始／鎖定中／待流轉／待廠商簽名(抽查表)／待主任加簽(抽查表)／已結案 */
  const WF_STORE = { self: 'selfChecks', spot: 'spotChecks' };
  const wfGet = (kind, id) => get(WF_STORE[kind], id);
  const wfSave = (kind, rec) => kind === 'self' ? saveSelf(rec) : put('spotChecks', rec);
  function wfLog(rec, user, action, detail, extra) { (rec.logs = rec.logs || []).push(Object.assign({ at: Date.now(), user, action, detail }, extra || {})); }
  async function wfLock(kind, id, user) {
    const rec = await wfGet(kind, id);
    if (!['未開始', '待流轉'].includes(rec.wfStatus)) throw new Error('目前狀態不可鎖定');
    rec.wfStatus = '鎖定中'; rec.lockedBy = user;
    wfLog(rec, user, rec.version > 0 ? '下載續填鎖定' : '下載鎖定', rec.version > 0 ? '下載最新版本並鎖定控制權，接續填寫。' : '下載空白範本並鎖定控制權，開始填寫表單。');
    await wfSave(kind, rec); return rec;
  }
  async function wfCancel(kind, id, user) {
    const rec = await wfGet(kind, id); rec.wfStatus = rec.version > 0 ? '待流轉' : '未開始'; rec.lockedBy = null;
    wfLog(rec, user, '取消鎖定', '放棄當次修改，釋放控制權。'); await wfSave(kind, rec); return rec;
  }
  // next（抽查表）：relay 其他局內人員續填／vendor 轉廠商簽名／supervisor 免廠商簽名逕轉主任加簽
  async function wfUpload(kind, id, user, { file, sig, next }) {
    const rec = await wfGet(kind, id); if (rec.wfStatus !== '鎖定中' || rec.lockedBy !== user) throw new Error('需由鎖定人上傳');
    rec.version = (rec.version || 0) + 1; rec.pdfFile = file; rec.lockedBy = null; rec.lastUpdatedBy = user;
    let detail;
    if (kind === 'self') { rec.wfStatus = '待流轉'; detail = '已完成 PDF 上傳並現地手寫簽名，待辦理憑證加簽結案。'; }
    else if (next === 'vendor') { rec.wfStatus = '待廠商簽名'; detail = '完成 PDF 上傳與現地手寫簽名，轉施工廠商辦理簽名確認。'; }
    else if (next === 'supervisor') { rec.wfStatus = '待主任加簽'; detail = '完成 PDF 上傳與現地手寫簽名，本案免施工廠商簽名，逕轉工務所主任辦理加簽及結案。'; }
    else { rec.wfStatus = '待流轉'; detail = '完成 PDF 上傳與現地手寫簽名，轉下一位局內人員接續鎖定辦理。'; }
    wfLog(rec, user, '上傳並簽名', detail, { file: { name: file.name, size: file.size, data: file.data }, sig });
    await wfSave(kind, rec); return rec;
  }
  async function wfVendorSign(id, user, file) {
    const rec = await wfGet('spot', id); if (rec.wfStatus !== '待廠商簽名') throw new Error('目前狀態不需廠商簽名');
    rec.version = (rec.version || 0) + 1; rec.pdfFile = file; rec.lastUpdatedBy = user; rec.wfStatus = '待主任加簽';
    wfLog(rec, user, '廠商簽名確認', '施工廠商已上傳完成簽名之 PDF，轉工務所主任辦理加簽及結案。', { file: { name: file.name, size: file.size, data: file.data } });
    await put('spotChecks', rec); return rec;
  }
  async function wfClose(kind, id, user, method) {
    const rec = await wfGet(kind, id);
    rec.version = (rec.version || 0) + 1; rec.lastUpdatedBy = user; rec.wfStatus = '已結案'; rec.lockedBy = null;
    wfLog(rec, user, kind === 'self' ? '憑證加簽結案' : '主任加簽結案', `經${method === 'tw-fido' ? '行動自然人憑證（TW FidO）' : '實體自然人憑證'}數位簽章認證，表單正式結案。`, { file: rec.pdfFile ? { name: rec.pdfFile.name, size: rec.pdfFile.size, data: rec.pdfFile.data } : null });
    if (kind === 'self') {
      rec.hash = await hashOf({ p: [rec.pdfFile.name, rec.pdfFile.size], v: rec.templateVer, n: rec.version }); rec.status = 'signed'; rec.signatures = { site: { at: Date.now(), name: user } };
      await saveSelf(rec); return rec;
    }
    await put('spotChecks', rec); return finalizeSpot(id);
  }
  async function wfUnfreeze(kind, id, user, reason) {
    const rec = await wfGet(kind, id); if (kind === 'spot' && rec.requestId) throw new Error('已放行／判定之會驗抽查不可解除結案');
    rec.wfStatus = kind === 'spot' ? '待主任加簽' : '待流轉'; rec.status = 'draft'; wfLog(rec, user, '解除結案', `原因：${reason}`); await wfSave(kind, rec); return rec;
  }
  async function migratePdfWf() {
    for (const [kind, store] of [['self', 'selfChecks'], ['spot', 'spotChecks']]) {
      for (const r of (await all(store)).filter(x => x.fillMode === 'pdf' && !x.wfStatus)) {
        r.wfStatus = r.status === 'signed' ? '已結案' : r.pdfFile ? '待流轉' : '未開始'; r.version = r.pdfFile ? 1 : 0; r.lockedBy = null; r.lastUpdatedBy = r.pdfFile ? '示範品管' : null; r.logs = r.logs || [];
        await put(store, r);
      }
    }
  }

  // 缺失：廠商回報改善（須說明＋照片）→ 工務所複查（合格結案／退回重新改善）
  async function reportFix(id, { note, photos, by }) {
    const df = await get('defects', id); if (df.status !== 'open') throw new Error('此缺失目前不是「待改善」狀態');
    if (!(note || '').trim()) throw new Error('請填寫改善說明'); if (!(photos || []).length) throw new Error('請至少附 1 張改善後照片');
    df.status = 'review'; df.fix = { note: note.trim(), photos, at: Date.now(), by }; (df.history = df.history || []).push({ at: Date.now(), text: `${by} 回報改善完成：${note.trim()}` });
    await put('defects', df); return df;
  }
  async function reviewDefect(id, pass, reason, by) {
    const df = await get('defects', id); if (df.status !== 'review') throw new Error('廠商尚未回報改善，不可複查結案');
    if (!pass && !(reason || '').trim()) throw new Error('請填寫退回原因');
    (df.history = df.history || []).push({ at: Date.now(), text: pass ? `${by} 複查合格，結案` : `${by} 複查不合格，退回重新改善：${reason.trim()}` });
    if (pass) { df.status = 'closed'; df.closedAt = Date.now(); df.note = `${by} 複查合格`; } else { df.status = 'open'; df.lastFix = df.fix; df.fix = null; df.note = '退回：' + reason.trim(); }
    await put('defects', df); return df;
  }
  async function setDefectStatus(id, status, note) {
    const d = await get('defects', id); d.status = status; if (note != null) d.note = note; if (status === 'closed') d.closedAt = Date.now();
    (d.history = d.history || []).push({ at: Date.now(), text: note || ({ open: '轉待改善', review: '轉待複查', closed: '結案' })[status] || status }); return put('defects', d);
  }

  /* ---------- 版本控制 ---------- */
  // 範本已被使用 → 另存為新版本；未使用 → 直接覆寫
  async function saveTemplate(tpl, asNewVersion) {
    ensureKeys(tpl);
    if (!asNewVersion) return put('templates', tpl);
    const old = await get('templates', tpl.id);
    old.status = 'superseded'; await put('templates', old);
    const nv = clone(tpl); nv.id = tpl.id.replace(/-v\d+$/, '') + '-v' + (tpl.version + 1); nv.version = tpl.version + 1; nv.status = 'published'; nv.used = 0;
    await put('templates', nv); return nv;
  }

  window.QMS = {
    ready, open, all, get, put, del, seed, getParams, onChange: f => listeners.push(f),
    LINKED, JUDGE, STAGES, DEF_STAGES, stagesOf, stageName, HOLD_TEXT, REQ_TEXT, H, D,
    fmtDT, fmtD, fmtFull, toLocalInput, fromLocalInput, nextHour, atDay, relTime, uid, clone, hashOf,
    evalField, suggest, rangeText, stageItems, stageDone, lockReason, holdState,
    STEP_TEXT, PROJ_TYPE_TEXT, DEPTS, rocDate, sortTenders, tenderFromProj, tLabel, tenderInDept, projKey, projOptions,
    tickOverdue, newSelfCheck, saveSelf, applyHold, schedule, reject, spotOptions, startInspection, cancelInspection, reportFix, reviewDefect, newSpotCheck, autoNa, migrateSpots, wfLock, wfCancel, wfUpload, wfVendorSign, wfClose, wfUnfreeze, pdfBlobUrl, downloadPdf, downloadAny, openAny, canPreview, fileToDataUrl, fmtSize, dataUrlSize, createDefect, finalizeSelf, finalizeSpot, setDefectStatus, saveTemplate, putMany, F, I, ensureKeys, baseId
  };
})();
