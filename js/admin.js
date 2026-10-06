/* 後台管理頁 (Vue 3 全域版 + IndexedDB) */
const { createApp, reactive, ref, computed, watch, onMounted, nextTick } = Vue;

createApp({
  setup() {
    const Q = QMS;
    const d = reactive({ tenders: [], subworks: [], templates: [], selfChecks: [], requests: [], spotChecks: [], defects: [], docs: [], users: [], params: {} });
    const now = ref(Date.now());
    const loaded = ref(false);
    const page = ref((location.hash || '#dashboard').slice(1));
    const menuOpen = ref(false);
    const toastMsg = ref(''), toastNg = ref(false);
    function toast(m, ng) { toastMsg.value = m; toastNg.value = !!ng; setTimeout(() => { toastMsg.value = ''; }, 2600); }

    async function load() {
      const [tenders, subworks, templates, selfChecks, requests, spotChecks, defects, docs, users, params] = await Promise.all(
        ['tenders', 'subworks', 'templates', 'selfChecks', 'requests', 'spotChecks', 'defects', 'docs', 'users'].map(s => Q.all(s)).concat([Q.getParams()]));
      Object.assign(d, { tenders, subworks, templates, selfChecks, requests, spotChecks, defects, docs, users, params });
      now.value = Date.now(); loaded.value = true;
    }
    function go(p) { page.value = p; location.hash = p; menuOpen.value = false; window.scrollTo(0, 0); }
    window.addEventListener('hashchange', () => { page.value = (location.hash || '#dashboard').slice(1); });

    /* ---------- 共用 ---------- */
    const tenderById = id => d.tenders.find(t => t.id === id) || {};
    const swById = id => d.subworks.find(s => s.id === id) || {};
    const tenderFilter = ref('all');
    const ft = arr => tenderFilter.value === 'all' ? arr : arr.filter(x => x.tenderId === tenderFilter.value);
    const supervisors = computed(() => d.users.filter(u => /監造/.test(u.role)));
    const reqCls = r => ({ pending: 'warn', scheduled: 'blue', inspecting: 'blue', passed: 'ok', failed: 'ng', rejected: 'ng' }[r.status]);
    const rel = ts => Q.relTime(ts, now.value);
    const openReqs = computed(() => ft(d.requests).filter(r => r.status === 'pending').sort((a, b) => a.replyDue - b.replyDue));
    const overdueReqs = computed(() => openReqs.value.filter(r => r.replyDue < now.value));
    const openDefects = computed(() => ft(d.defects).filter(x => x.status !== 'closed'));
    const overdueDefects = computed(() => openDefects.value.filter(x => x.due < now.value));
    const weekHolds = computed(() => ft(d.requests).filter(r => ['scheduled', 'pending'].includes(r.status) && r.scheduledAt >= now.value - Q.D && r.scheduledAt < now.value + 7 * Q.D));
    const spotRate = computed(() => { const n = ft(d.selfChecks).length; return n ? Math.round(ft(d.spotChecks).length / n * 100) : 0; });
    const todayAgenda = computed(() => {
      const s = new Date(); s.setHours(0, 0, 0, 0); const a = s.getTime(), b = a + Q.D;
      return ft(d.requests).filter(r => ['scheduled', 'inspecting', 'pending'].includes(r.status) && r.scheduledAt >= a && r.scheduledAt < b).sort((x, y) => x.scheduledAt - y.scheduledAt);
    });
    const tplOf = id => d.templates.find(t => t.id === id);
    const usedCount = t => d.selfChecks.filter(s => s.templateId === t.id).length + d.spotChecks.filter(s => s.templateId === t.id).length;

    /* ---------- 品管總覽：分項進度 ---------- */
    const progTender = ref('T671'), progFilter = ref('施工中');
    const progRows = computed(() => d.subworks.filter(s => s.tenderId === progTender.value).sort((a, b) => a.order - b.order).map(s => {
      const selfT = d.templates.filter(t => t.subworkId === s.id && t.kind === 'self' && t.status === 'published');
      const spotT = d.templates.filter(t => t.subworkId === s.id && t.kind === 'spot' && t.status === 'published');
      const spots = d.spotChecks.filter(p => p.subworkId === s.id);
      const rate = spots.length ? Math.round(spots.filter(p => p.judge !== 'ng').length / spots.length * 100) : null;
      return { sw: s, selfN: selfT.length, spotN: spotT.length, holdN: selfT.reduce((n, t) => n + t.items.filter(i => i.hold).length, 0), rate, open: d.defects.filter(x => x.subworkId === s.id && x.status !== 'closed').length };
    }).filter(r => progFilter.value === '全部' || r.sw.status === progFilter.value));
    const progCount = status => d.subworks.filter(s => s.tenderId === progTender.value && (status === '全部' || s.status === status)).length;

    /* ---------- 停留點會驗管理 ---------- */
    const holdTab = ref('pending'), selReqId = ref(null), calView = ref(false);
    const sched = reactive({ dt: '', inspector: '', reason: '', rejecting: false });
    const holdTabs = [['pending', '待回覆'], ['scheduled', '已排定'], ['inspecting', '檢驗中'], ['passed', '合格放行'], ['failed', '不合格'], ['rejected', '已退回'], ['all', '全部']];
    const holdCount = k => ft(d.requests).filter(r => k === 'all' || r.status === k).length;
    const holdList = computed(() => ft(d.requests).filter(r => holdTab.value === 'all' || r.status === holdTab.value).sort((a, b) => holdTab.value === 'pending' ? a.replyDue - b.replyDue : b.scheduledAt - a.scheduledAt));
    const holdByDate = computed(() => { const m = {}; holdList.value.forEach(r => { (m[Q.fmtD(r.scheduledAt)] = m[Q.fmtD(r.scheduledAt)] || []).push(r); }); return Object.entries(m); });
    const selReq = computed(() => d.requests.find(r => r.id === selReqId.value));
    watch(selReqId, () => {
      const r = selReq.value; if (!r) return;
      sched.dt = Q.toLocalInput(r.scheduledAt); sched.inspector = r.inspector || (supervisors.value[0] || {}).name || ''; sched.reason = ''; sched.rejecting = false;
    });
    watch(holdList, l => { if (!l.find(r => r.id === selReqId.value)) selReqId.value = l.length ? l[0].id : null; }, { immediate: true });
    const reqChips = r => {
      const sc = d.selfChecks.find(s => s.id === r.scId), tpl = sc && tplOf(sc.templateId), it = tpl && tpl.items.find(i => i.no === r.itemNo);
      if (!it) return [];
      return it.fields.filter(f => (r.values || {})[f.key] !== undefined && (r.values || {})[f.key] !== '').map(f => `${f.label} ${r.values[f.key]}${f.unit ? ' ' + f.unit : ''}`);
    };
    const lockedAfter = r => {
      const sc = d.selfChecks.find(s => s.id === r.scId), tpl = sc && tplOf(sc.templateId); if (!tpl) return [];
      return tpl.items.filter(i => i.hold && i.no > r.itemNo && Q.holdState(sc, i.no) !== 'passed').map(i => i.name);
    };
    const hoursBefore = r => Math.max(0, Math.round((r.scheduledAt - r.appliedAt) / Q.H));
    async function doSchedule() {
      const r = selReq.value; const ts = Q.fromLocalInput(sched.dt);
      if (!ts) return toast('請選擇會驗時間', true);
      await Q.schedule(r.id, ts, sched.inspector, r.status === 'scheduled'); await load(); toast(r.status === 'pending' ? '已確認排定，並 Email 通知廠商' : '已改期');
    }
    async function doReject() {
      if (!sched.reason.trim()) return toast('請填寫退回原因', true);
      await Q.reject(selReq.value.id, sched.reason); sched.rejecting = false; await load(); toast('已退回申請');
    }
    async function doStart() { await Q.startInspection(selReq.value.id); await load(); toast('已建立抽查紀錄，請至現場作業頁填寫（平板／手機）'); }

    /* ---------- 紀錄清單 ---------- */
    const showSC = ref(null), showSP = ref(null);
    const itemsOf = sc => { const t = tplOf(sc.templateId); return t ? t.items.map(i => ({ it: i, a: sc.answers[i.no] || {} })) : []; };
    const judgeText = j => j ? Q.JUDGE[j] : '—';
    const valuesText = (it, a) => it.fields.filter(f => (a.values || {})[f.key] !== undefined && a.values[f.key] !== '').map(f => `${f.label} ${a.values[f.key]}${f.unit || ''}`).join('、');
    const spotItem = sp => { const t = tplOf(sp.templateId); return t && (t.items.find(i => i.srcNo === sp.itemNo) || {}); };
    const defCls = x => x.status === 'closed' ? 'ok' : x.due < now.value ? 'ng' : x.status === 'review' ? 'warn' : 'blue';
    const defText = x => x.status === 'closed' ? '已結案' : x.status === 'review' ? '待複查' : x.due < now.value ? `逾期 ${Math.ceil((now.value - x.due) / Q.D)} 天` : '改善中';
    const defTab = ref('open');
    const defList = computed(() => ft(d.defects).filter(x => defTab.value === 'all' || (defTab.value === 'open' ? x.status !== 'closed' : x.status === 'closed')).sort((a, b) => a.due - b.due));
    async function defAct(x, st) { await Q.setDefectStatus(x.id, st); await load(); toast(st === 'closed' ? '缺失已結案' : '已標記待複查'); }

    /* ---------- 標案與分項工程 ---------- */
    const selTenderId = ref('T671'), swSearch = ref(''), swStatus = ref(''), swPage = ref(1);
    const selTender = computed(() => tenderById(selTenderId.value));
    const swAll = computed(() => d.subworks.filter(s => s.tenderId === selTenderId.value).sort((a, b) => a.order - b.order).filter(s => (!swSearch.value || s.name.includes(swSearch.value)) && (!swStatus.value || s.status === swStatus.value)));
    const swPaged = computed(() => swAll.value.slice((swPage.value - 1) * 15, swPage.value * 15));
    const swPages = computed(() => Math.max(1, Math.ceil(swAll.value.length / 15)));
    watch([swSearch, swStatus, selTenderId], () => { swPage.value = 1; });
    const swTplText = (s, kind) => { const n = d.templates.filter(t => t.subworkId === s.id && t.kind === kind && t.status === 'published').length; return n ? n + ' 張' : '未設定'; };
    const swHold = s => d.templates.filter(t => t.subworkId === s.id && t.kind === 'self' && t.status === 'published').reduce((n, t) => n + t.items.filter(i => i.hold).length, 0);
    const tenderForm = ref(null), swForm = ref(null);
    async function saveTender() { await Q.put('tenders', tenderForm.value); tenderForm.value = null; await load(); toast('標案已儲存'); }
    async function saveSw() {
      const s = swForm.value; if (!s.name.trim()) return toast('請輸入分項工程名稱', true);
      if (!s.id) { s.id = Q.uid('S'); s.order = d.subworks.length; s.tenderId = selTenderId.value; }
      s.qty = Number(s.qty) || 0; await Q.put('subworks', s); swForm.value = null; await load(); toast('分項工程已儲存');
    }
    async function moveSw(s, dir) {
      const list = d.subworks.filter(x => x.tenderId === s.tenderId).sort((a, b) => a.order - b.order), i = list.findIndex(x => x.id === s.id), j = i + dir;
      if (j < 0 || j >= list.length) return;
      const a = list[i], b = list[j]; const t = a.order; a.order = b.order; b.order = t; await Q.put('subworks', a); await Q.put('subworks', b); await load();
    }
    async function delSw(s) { if (!confirm(`刪除分項工程「${s.name}」？`)) return; await Q.del('subworks', s.id); await load(); }
    function newTender() { tenderForm.value = { id: Q.uid('T'), code: '', name: '', status: '施工中', contractor: '', supervisor: '', site: '', start: '', end: '', external: '', desc: '', members: 0 }; }

    /* ---------- 表單範本 ---------- */
    // 分項工程下拉：先依標號，再依項次(order)排列
    const swGroups = computed(() => d.tenders.slice().sort((a, b) => a.code.localeCompare(b.code)).map(t => ({ tender: t, subs: d.subworks.filter(s => s.tenderId === t.id).sort((a, b) => a.order - b.order) })).filter(g => g.subs.length));
    const tplSw = ref('S671-5'), selTplId = ref(null), tplTab = ref('items'), edit = ref(null), previewOn = ref(false), fieldIdx = ref(-1);
    const tplList = kind => d.templates.filter(t => t.subworkId === tplSw.value && t.kind === kind && t.status === 'published');
    const tplHistory = computed(() => edit.value ? d.templates.filter(t => t.code === edit.value.code && t.subworkId === edit.value.subworkId && t.kind === edit.value.kind).sort((a, b) => b.version - a.version) : []);
    function pickTpl(t) { selTplId.value = t.id; edit.value = Q.clone(t); tplTab.value = 'items'; }
    watch(tplSw, () => { const l = tplList('self')[0] || tplList('spot')[0]; if (l) pickTpl(l); else { selTplId.value = null; edit.value = null; } });
    watch(() => d.templates.length, () => { if (!edit.value && loaded.value) { const l = tplList('self')[0]; if (l) pickTpl(l); } });
    const editUsed = computed(() => edit.value ? usedCount(edit.value) : 0);
    const editStages = computed(() => edit.value ? ['pre', 'during', 'post'].map(s => ({ key: s, name: Q.STAGES[s], items: edit.value.items.map((it, idx) => ({ it, idx })).filter(x => x.it.stage === s) })) : []);
    const TYPES = { option: '選項', number: '數值', photo: '照片', text: '文字', linked: '連結表單' };
    const holdN = computed(() => edit.value ? edit.value.items.filter(i => i.hold).length : 0);
    function addItem(stage) { edit.value.items.push(Q.I(0, stage, '新檢查項目', '', { photo: false })); }
    function delItem(idx) { edit.value.items.splice(idx, 1); }
    function moveItem(idx, dir) {
      const arr = edit.value.items, it = arr[idx]; let j = idx + dir;
      while (j >= 0 && j < arr.length && arr[j].stage !== it.stage) j += dir;
      if (j < 0 || j >= arr.length) return; arr.splice(idx, 1); arr.splice(j, 0, it);
    }
    function addField(it) { it.fields.push(Q.F('f' + (it.fields.length + 1), '實測值', '', null, null)); }
    function onType(it) { if (it.type === 'number' && !it.fields.length) addField(it); if (it.type !== 'linked') it.linked = ''; else if (!it.linked) it.linked = '5-4'; }
    function finalizeItems(t) {
      const order = { pre: 0, during: 1, post: 2 };
      t.items = t.items.map((x, i) => [x, i]).sort((a, b) => order[a[0].stage] - order[b[0].stage] || a[1] - b[1]).map(x => x[0]);
      t.items.forEach((x, i) => { x.no = i + 1; if (t.kind === 'self' || !x.srcNo) x.srcNo = x.srcNo || x.no; });
      return t;
    }
    async function saveEdit() {
      if (!edit.value.name.trim()) return toast('請輸入表單名稱', true);
      const t = finalizeItems(Q.clone(edit.value)); const asNew = editUsed.value > 0;
      const saved = await Q.saveTemplate(t, asNew); await load(); pickTpl(d.templates.find(x => x.id === saved.id));
      toast(asNew ? `已另存為 v${saved.version}，舊版紀錄保留原內容` : '範本已儲存');
    }
    function syncFromSelf() {
      const self = d.templates.find(t => t.id === edit.value.pairedSelf); if (!self) return toast('此抽查表未對應自主檢查表', true);
      let added = 0;
      self.items.forEach(si => { if (!edit.value.items.find(x => x.srcNo === si.no)) { const c = Q.clone(si); c.srcNo = si.no; c.hold = false; edit.value.items.push(c); added++; } });
      toast(added ? `已同步 ${added} 項` : '已與自主檢查表同步，無新增項目');
    }
    async function newTpl(kind) {
      const code = kind === 'self' ? '新表' : 'SP-新';
      const t = { id: Q.uid('TP-'), tenderId: swById(tplSw.value).tenderId, subworkId: tplSw.value, kind, code, name: kind === 'self' ? '新自主檢查表' : '新抽查記錄表', version: 1, status: 'published', source: '', items: [Q.I(1, 'pre', '新檢查項目', '')], used: 0 };
      await Q.put('templates', t); await load(); pickTpl(d.templates.find(x => x.id === t.id));
    }
    async function delTpl() {
      const t = edit.value, vers = d.templates.filter(x => x.code === t.code && x.subworkId === t.subworkId && x.kind === t.kind && (x.id === t.id || x.id.replace(/-v\d+$/, '') === t.id.replace(/-v\d+$/, '')));
      const used = vers.reduce((n, v) => n + usedCount(v), 0);
      if (used > 0) return toast(`此表單已有 ${used} 張填寫紀錄，不可刪除（刪除會讓紀錄失去版本內容）`, true);
      if (!confirm(`確定刪除「${t.name}」${vers.length > 1 ? `（含 ${vers.length} 個版本）` : ''}？此動作無法復原。`)) return;
      for (const v of vers) await Q.del('templates', v.id);
      selTplId.value = null; edit.value = null; await load();
      const l = tplList('self')[0] || tplList('spot')[0]; if (l) pickTpl(l);
      toast('已刪除表單範本');
    }
    function download(name, text, type) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: type || 'text/csv;charset=utf-8' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const CSV_HEAD = ['範本名稱', '階段', '項次', '檢查項目', '檢查標準', '判定類型', '停留點', '必填', '引用文件編號'];
    function exportCsv() {
      const t = edit.value, rows = [CSV_HEAD].concat(t.items.map(i => [t.name, Q.STAGES[i.stage], i.no, i.name, i.std, TYPES[i.type] || '選項', i.hold ? 'Y' : 'N', i.photo ? 'Y' : 'N', i.ref || '']));
      download(`${t.code}_${t.name}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
    }

    /* ---------- CSV 匯入 ---------- */
    const imp = reactive({ step: 1, text: '', fileName: '', groups: [], selGroup: 0, mode: 'new', targetSw: 'S671-5', existing: '', err: '', done: 0, sheets: [] });
    function parseCsv(text) {
      const rows = []; let row = [], cell = '', q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
        else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
      }
      if (cell !== '' || row.length) { row.push(cell); rows.push(row); } return rows.filter(r => r.some(x => x.trim() !== ''));
    }
    const RT = { 選項: 'option', 數值: 'number', 照片: 'photo', 文字: 'text', 連結表單: 'linked' }, SR = { 施工前: 'pre', 施工中: 'during', 施工後: 'post' };
    function validate() {
      imp.err = '';
      const sheets = imp.sheets.length ? imp.sheets : [{ name: '貼上內容', rows: parseCsv(imp.text.replace(/^﻿/, '')) }];
      const groups = {}; let usable = 0, lastMiss = '';
      sheets.forEach(sh => {
        const rows = sh.rows.filter(r => r.some(x => String(x).trim() !== ''));
        if (rows.length < 2) return;
        const head = rows[0].map(x => String(x).trim()), miss = CSV_HEAD.filter(h => !head.includes(h));
        if (miss.length) { lastMiss = `工作表「${sh.name}」缺少欄位：` + miss.join('、'); return; }
        usable++;
        const idx = Object.fromEntries(CSV_HEAD.map(h => [h, head.indexOf(h)])), cell = (r, h) => String(r[idx[h]] == null ? '' : r[idx[h]]).trim();
        rows.slice(1).forEach((r, k) => {
          const g = cell(r, '範本名稱') || '（未命名）', errs = [];
          const stage = SR[cell(r, '階段')], type = RT[cell(r, '判定類型')], ref = cell(r, '引用文件編號');
          if (!stage) errs.push('階段須為 施工前／施工中／施工後');
          if (!type) errs.push('判定類型「' + cell(r, '判定類型') + '」不在代碼表內（選項／數值／照片／文字／連結表單）');
          if (!cell(r, '檢查項目')) errs.push('檢查項目不可空白');
          if (ref && !d.docs.find(x => x.code === ref)) errs.push('引用文件編號「' + ref + '」不存在於參考文件庫');
          (groups[g] = groups[g] || { name: g, rows: [] }).rows.push({ line: k + 2, sheet: sh.name, stage, type, name: cell(r, '檢查項目'), std: String(r[idx['檢查標準']] == null ? '' : r[idx['檢查標準']]), hold: /^y/i.test(cell(r, '停留點')), photo: /^y/i.test(cell(r, '必填')), ref, raw: r, idx, errs });
        });
      });
      if (!usable) { imp.err = lastMiss || '沒有資料列，請上傳 Excel／CSV 或貼上內容'; return; }
      imp.groups = Object.values(groups).map(g => Object.assign(g, { bad: g.rows.filter(r => r.errs.length).length })); imp.selGroup = 0; imp.step = 3;
    }
    function onFile(e) {
      const f = e.target.files[0]; if (!f) return; imp.fileName = f.name; imp.err = ''; imp.sheets = []; imp.text = '';
      const rd = new FileReader();
      if (/\.xlsx?$/i.test(f.name)) {
        if (!window.XLSX) { imp.err = 'Excel 函式庫未載入'; return; }
        rd.onload = () => {
          try {
            const wb = XLSX.read(rd.result, { type: 'array' });
            imp.sheets = wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }) }));
            imp.step = 2; validate();
          } catch (ex) { imp.err = '無法讀取 Excel：' + ex.message; }
        };
        rd.readAsArrayBuffer(f);
      } else { rd.onload = () => { imp.text = rd.result; imp.step = 2; }; rd.readAsText(f, 'utf-8'); }
    }
    const SAMPLE_ROWS = () => [CSV_HEAD, ['表5-6 鋼筋籠自主檢查表', '施工前', 1, '施工圖', '是否核准', '選項', 'Y', 'Y', 'CF671-PL-0032'], ['表5-6 鋼筋籠自主檢查表', '施工中', 2, '焊條使用是否符合要求', '使用 AWS D1.4 E8016', '選項', 'N', 'N', ''], ['表5-6 鋼筋籠自主檢查表', '施工中', 3, '鋼筋剪力筋是否依設計數量安放', '依施工圖標示', 'Y/N', 'N', 'N', ''], ['表5-6 鋼筋籠自主檢查表', '施工中', 4, '鋼筋籠端板是否牢固', '端板厚度 6mm', '數值', 'N', 'N', 'CF671-DW-9999'], ['表5-6 鋼筋籠自主檢查表', '施工後', 5, '場地清理', '是否清理完成', '選項', 'N', 'N', '']];
    function sampleCsv() { return SAMPLE_ROWS().map(r => r.map(csvCell).join(',')).join('\r\n'); }
    function loadSample() { imp.fileName = '範本匯入樣本.xlsx'; imp.sheets = [{ name: '範本', rows: SAMPLE_ROWS() }]; imp.step = 2; validate(); }
    function writeXlsx(name, rows, sheetName) {
      const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = CSV_HEAD.map((h, i) => ({ wch: [26, 8, 6, 28, 36, 10, 8, 6, 16][i] }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheetName || '範本'); XLSX.writeFile(wb, name);
    }
    function downloadSample() { writeXlsx('範本匯入樣本.xlsx', SAMPLE_ROWS()); }
    function exportXlsx() {
      const t = edit.value; writeXlsx(`${t.code}_${t.name}.xlsx`, [CSV_HEAD].concat(t.items.map(i => [t.name, Q.STAGES[i.stage], i.no, i.name, i.std, TYPES[i.type] || '選項', i.hold ? 'Y' : 'N', i.photo ? 'Y' : 'N', i.ref || ''])), t.code);
    }
    const impOk = computed(() => imp.groups.filter(g => !g.bad));
    async function doImport() {
      let n = 0;
      for (const g of impOk.value) {
        const items = g.rows.map((r, i) => Q.I(i + 1, r.stage, r.name, r.std, { type: r.type, hold: r.hold, photo: r.photo, ref: r.ref || '', fields: r.type === 'number' ? [Q.F('v', '實測值', '', null, null)] : [], linked: r.type === 'linked' ? '5-4' : '' }));
        if (imp.mode === 'version' && imp.existing) {
          const old = d.templates.find(t => t.id === imp.existing); const nt = Q.clone(old); nt.items = items; await Q.saveTemplate(nt, true);
        } else {
          const sw = swById(imp.targetSw);
          await Q.put('templates', { id: Q.uid('TP-'), tenderId: sw.tenderId, subworkId: sw.id, kind: 'self', code: '匯入', name: g.name, version: 1, status: 'published', source: '匯入：' + (imp.fileName || '貼上內容'), items, used: 0 });
        }
        n++;
      }
      await load(); imp.step = 4; imp.done = n;
    }
    function impReset() { Object.assign(imp, { step: 1, text: '', fileName: '', groups: [], err: '', sheets: [] }); }

    /* ---------- 其他 ---------- */
    const docForm = ref(null), userForm = ref(null);
    async function saveDoc() { const x = docForm.value; if (!x.code.trim()) return toast('請輸入文件編號', true); x.id = x.code; await Q.put('docs', x); docForm.value = null; await load(); }
    async function saveUser() { const x = userForm.value; if (!x.name.trim()) return toast('請輸入姓名', true); if (!x.id) x.id = Q.uid('U'); await Q.put('users', x); userForm.value = null; await load(); }
    async function delRow(store, id) { if (!confirm('確定刪除？')) return; await Q.del(store, id); await load(); }
    async function saveParams() {
      const p = d.params; ['holdAdvanceHours', 'replyHours', 'photoMaxKB', 'defectDueDays'].forEach(k => { p[k] = Number(p[k]) || 0; });
      await Q.put('meta', Object.assign({ id: 'params' }, p)); toast('參數已儲存');
    }
    async function resetDemo() { if (!confirm('將清除所有資料並還原示範資料，確定？')) return; await Q.seed(true); await load(); toast('已還原示範資料'); }
    const navItems = [['dashboard', '品管總覽'], ['g', '品管作業'], ['holds', '停留點會驗', 'badge'], ['selfchecks', '自主檢查紀錄'], ['spots', '抽查紀錄'], ['defects', '缺失追蹤', 'dbadge'], ['g', '基本資料'], ['projects', '標案與分項工程'], ['templates', '表單範本'], ['import', '範本匯入'], ['docs', '參考文件'], ['g', '系統'], ['users', '帳號與權限'], ['params', '參數設定']];
    const titles = Object.fromEntries(navItems.filter(n => n[0] !== 'g').map(n => [n[0], n[1]]));
    const todayStr = () => { const t = new Date(); return `${Q.fmtD(t)}（${'日一二三四五六'[t.getDay()]}）`; };

    onMounted(async () => {
      await Q.ready; await load(); const l = tplList('self').sort((a, b) => b.items.length - a.items.length)[0]; if (l) pickTpl(l);
      Q.onChange(async () => { await load(); });
      setInterval(async () => { await Q.tickOverdue(); await load(); }, 30000);
    });

    return {
      Q, d, now, loaded, page, menuOpen, toastMsg, toastNg, toast, go, tenderById, swById, tenderFilter, supervisors, reqCls, rel, openReqs, overdueReqs, openDefects, overdueDefects, weekHolds, spotRate, todayAgenda, tplOf, usedCount,
      progTender, progFilter, progRows, progCount, holdTab, holdTabs, holdCount, holdList, holdByDate, selReqId, selReq, calView, sched, reqChips, lockedAfter, hoursBefore, doSchedule, doReject, doStart,
      showSC, showSP, itemsOf, judgeText, valuesText, spotItem, defCls, defText, defTab, defList, defAct,
      selTenderId, selTender, swSearch, swStatus, swPage, swPages, swPaged, swAll, swTplText, swHold, tenderForm, swForm, saveTender, saveSw, moveSw, delSw, newTender,
      tplSw, swGroups, selTplId, tplTab, edit, previewOn, fieldIdx, tplList, tplHistory, pickTpl, editUsed, editStages, TYPES, holdN, addItem, delItem, moveItem, addField, onType, saveEdit, delTpl, syncFromSelf, newTpl, exportCsv, exportXlsx,
      imp, validate, onFile, sampleCsv, loadSample, downloadSample, impOk, doImport, impReset, download,
      docForm, userForm, saveDoc, saveUser, delRow, saveParams, resetDemo, navItems, titles, todayStr
    };
  }
}).mount('#app');
