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
    const supervisors = computed(() => d.users.filter(u => /工務所/.test(u.role)));
    const reqCls = r => ({ pending: 'warn', scheduled: 'blue', inspecting: 'blue', passed: 'ok', failed: 'ng', rejected: 'ng' }[r.status]);
    const rel = ts => Q.relTime(ts, now.value);
    const openReqs = computed(() => ft(d.requests).filter(r => r.status === 'pending').sort((a, b) => a.replyDue - b.replyDue));
    const overdueReqs = computed(() => openReqs.value.filter(r => r.replyDue < now.value));
    const openDefects = computed(() => ft(d.defects).filter(x => x.status !== 'closed'));
    const overdueDefects = computed(() => openDefects.value.filter(x => x.due < now.value));
    const today0 = () => { const t = new Date(now.value); t.setHours(0, 0, 0, 0); return t.getTime(); };
    const weekHolds = computed(() => ft(d.requests).filter(r => ['scheduled', 'pending', 'inspecting'].includes(r.status) && r.scheduledAt >= today0() && r.scheduledAt < today0() + 7 * Q.D));
    // 抽查統計：只計「已簽認／已結案」的抽查紀錄；PDF 抽查依上傳時的判定結果
    const spotDone = p => p.status === 'signed';
    const spotNg = p => p.fillMode === 'pdf' ? p.pdfResult === 'ng' : Object.values(p.answers || {}).some(a => a.judge === 'ng');
    // 抽查率 ＝ 有完成抽查的自主檢查表張數 ÷ 自主檢查表總張數（同一張表被抽查多次只算一次，不會超過 100%）
    const kpiSelf = computed(() => {
      const scs = ft(d.selfChecks), done = ft(d.spotChecks).filter(spotDone), ids = new Set(done.map(p => p.scId).filter(Boolean));
      const covered = scs.filter(s => ids.has(s.id)).length;
      return { n: scs.length, spots: done.length, covered, rate: scs.length ? Math.round(covered / scs.length * 100) : 0 };
    });
    const spotRate = computed(() => kpiSelf.value.rate);
    const todayAgenda = computed(() => {
      const s = new Date(); s.setHours(0, 0, 0, 0); const a = s.getTime(), b = a + Q.D;
      return ft(d.requests).filter(r => ['scheduled', 'inspecting', 'pending'].includes(r.status) && r.scheduledAt >= a && r.scheduledAt < b).sort((x, y) => x.scheduledAt - y.scheduledAt);
    });
    const tplOf = id => d.templates.find(t => t.id === id);
    const usedCount = t => d.selfChecks.filter(s => s.templateId === t.id).length + d.spotChecks.filter(s => s.templateId === t.id).length;

    /* ---------- 查驗總覽：分項進度 ---------- */
    const progTender = ref('T671'), progFilter = ref('施工中');
    const progRows = computed(() => d.subworks.filter(s => s.tenderId === progTender.value).sort((a, b) => a.order - b.order).map(s => {
      const selfT = d.templates.filter(t => t.subworkId === s.id && t.kind === 'self' && t.status === 'published');
      const spotT = d.templates.filter(t => t.subworkId === s.id && t.kind === 'spot' && t.status === 'published');
      const spots = d.spotChecks.filter(p => p.subworkId === s.id && spotDone(p));
      const rate = spots.length ? Math.round(spots.filter(p => !spotNg(p)).length / spots.length * 100) : null;
      return { sw: s, selfN: selfT.length, spotN: spotT.length, holdN: selfT.reduce((n, t) => n + t.items.filter(i => i.hold).length, 0), rate, open: d.defects.filter(x => x.subworkId === s.id && x.status !== 'closed').length };
    }).filter(r => progFilter.value === '全部' || r.sw.status === progFilter.value));
    const progCount = status => d.subworks.filter(s => s.tenderId === progTender.value && (status === '全部' || s.status === status)).length;

    /* ---------- 停留點會驗管理 ---------- */
    const holdTab = ref('pending'), selReqId = ref(null), calView = ref(false);
    const sched = reactive({ dt: '', inspector: '', reason: '', rejecting: false, cancelling: false, tplId: '', tplOpts: [] });
    const holdTabs = [['pending', '待回覆'], ['scheduled', '已排定'], ['inspecting', '檢驗中'], ['passed', '合格放行'], ['failed', '不合格'], ['rejected', '已退回'], ['all', '全部']];
    const holdCount = k => ft(d.requests).filter(r => k === 'all' || r.status === k).length;
    const holdList = computed(() => ft(d.requests).filter(r => holdTab.value === 'all' || r.status === holdTab.value).sort((a, b) => holdTab.value === 'pending' ? a.replyDue - b.replyDue : b.scheduledAt - a.scheduledAt));
    const holdByDate = computed(() => { const m = {}; holdList.value.forEach(r => { (m[Q.fmtD(r.scheduledAt)] = m[Q.fmtD(r.scheduledAt)] || []).push(r); }); return Object.entries(m); });
    const selReq = computed(() => d.requests.find(r => r.id === selReqId.value));
    watch(selReqId, () => {
      const r = selReq.value; if (!r) return;
      sched.dt = Q.toLocalInput(r.scheduledAt); sched.inspector = r.inspector || (supervisors.value[0] || {}).name || ''; sched.reason = ''; sched.rejecting = false; sched.cancelling = false; sched.tplOpts = []; sched.tplId = '';
      Q.spotOptions(r.id).then(o => { if (selReqId.value !== r.id) return; sched.tplOpts = o.tpls.map(t => ({ id: t.id, name: t.name, pdf: t.fillMode === 'pdf' })); sched.tplId = o.def ? o.def.id : ''; });
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
    async function doCancel() { try { await Q.cancelInspection(selReq.value.id, sched.reason, adminUser.value.name); sched.cancelling = false; sched.reason = ''; await load(); toast('已取消會驗，抽查紀錄草稿已作廢'); } catch (e) { toast(e.message, true); } }
    async function doStart() { try { await Q.startInspection(selReq.value.id, sched.tplId || undefined); await load(); toast('已建立抽查紀錄，請至現場作業頁填寫（平板／手機）'); } catch (e) { toast(e.message, true); } }

    /* ---------- 紀錄清單 ---------- */
    const showSC = ref(null), showSP = ref(null);
    const itemsOf = sc => { const t = tplOf(sc.templateId); return t ? t.items.map(i => ({ it: i, a: (sc.answers || {})[i.no] || {} })) : []; };
    const judgeText = j => j ? Q.JUDGE[j] : '—';
    const valuesText = (it, a) => it.fields.filter(f => (a.values || {})[f.key] !== undefined && a.values[f.key] !== '').map(f => `${f.label} ${a.values[f.key]}${f.unit || ''}`).join('、');
    const spotCount = (sp, j) => Object.values(sp.answers || {}).filter(a => a.judge === j).length;
    const defCls = x => x.status === 'closed' ? 'ok' : x.due < now.value ? 'ng' : x.status === 'review' ? 'warn' : 'blue';
    const defText = x => x.status === 'closed' ? '已結案' : x.status === 'review' ? '待複查' : x.due < now.value ? `逾期 ${Math.ceil((now.value - x.due) / Q.D)} 天` : '改善中';
    const defTab = ref('open');
    const defList = computed(() => ft(d.defects).filter(x => defTab.value === 'all' || (defTab.value === 'open' ? x.status !== 'closed' : x.status === 'closed')).sort((a, b) => a.due - b.due));
    // 缺失複查：須廠商回報改善後才可結案，可退回重新改善
    const defShow = ref(null);
    function defAct(x) { defShow.value = { x, reason: '', rejecting: false }; }
    async function defReview(pass) { const f = defShow.value; try { await Q.reviewDefect(f.x.id, pass, f.reason, adminUser.value.name); defShow.value = null; await load(); toast(pass ? '複查合格，缺失已結案' : '已退回廠商重新改善'); } catch (e) { toast(e.message, true); } }

    /* ---------- 標案與分項工程 ---------- */
    const selTenderId = ref('T671'), swSearch = ref(''), swStatus = ref(''), swPage = ref(1);
    const selTender = computed(() => tenderById(selTenderId.value));
    // 左側樹狀：各層可收合；點分項工程時右側直接篩選到該項
    const treeRoot = ref(true), treeOpen = reactive({ T671: true }), swPick = ref(null);
    function treeAll(open) { treeRoot.value = true; d.tenders.forEach(t => { treeOpen[t.id] = open; }); }
    function pickTender(t) { if (selTenderId.value === t.id && !swPick.value) { treeOpen[t.id] = !treeOpen[t.id]; return; } selTenderId.value = t.id; swPick.value = null; treeOpen[t.id] = true; }
    function pickSw(s) { selTenderId.value = s.tenderId; swSearch.value = ''; swStatus.value = ''; swPick.value = s.id; swPage.value = 1; }
    const swAll = computed(() => d.subworks.filter(s => s.tenderId === selTenderId.value).sort((a, b) => a.order - b.order).filter(s => (!swPick.value || s.id === swPick.value) && (!swSearch.value || s.name.includes(swSearch.value)) && (!swStatus.value || s.status === swStatus.value)));
    const swPaged = computed(() => swAll.value.slice((swPage.value - 1) * 15, swPage.value * 15));
    const swPages = computed(() => Math.max(1, Math.ceil(swAll.value.length / 15)));
    watch([swSearch, swStatus, selTenderId], () => { swPage.value = 1; });
    watch(selTenderId, id => { if (swPick.value && (d.subworks.find(s => s.id === swPick.value) || {}).tenderId !== id) swPick.value = null; });
    const swTplText = (s, kind) => { const l = d.templates.filter(t => t.subworkId === s.id && t.kind === kind && t.status === 'published'); const p = l.filter(t => t.fillMode === 'pdf').length; return l.length ? l.length + ' 張' + (p ? `（PDF ${p}）` : '') : '未設定'; };
    const swHold = s => d.templates.filter(t => t.subworkId === s.id && t.kind === 'self' && t.status === 'published').reduce((n, t) => n + (t.fillMode === 'pdf' ? 0 : t.items.filter(i => i.hold).length), 0);
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
    // 刪除前檢查引用：有範本或紀錄就不可刪
    function swRefs(s) { const n = (arr, f) => arr.filter(f).length; return [['表單範本', n(d.templates, t => t.subworkId === s.id)], ['自主檢查紀錄', n(d.selfChecks, x => x.subworkId === s.id)], ['抽查紀錄', n(d.spotChecks, x => x.subworkId === s.id)], ['會驗申請', n(d.requests, x => x.subworkId === s.id)], ['缺失', n(d.defects, x => x.subworkId === s.id)]].filter(x => x[1]); }
    async function delSw(s) {
      const refs = swRefs(s); if (refs.length) return toast(`「${s.name}」已有 ${refs.map(r => r[0] + ' ' + r[1] + ' 筆').join('、')}，不可刪除；不再使用請將狀態改為「已完工」`, true);
      if (!confirm(`刪除分項工程「${s.name}」？`)) return; await Q.del('subworks', s.id); await load();
    }
    function newTender() { tenderForm.value = { id: Q.uid('T'), code: '', name: '', status: '施工中', contractor: '', supervisor: '', site: '', start: '', end: '', external: '', desc: '', members: 0 }; }

    /* ---------- 表單範本 ---------- */
    // 分項工程下拉：先依標號，再依項次(order)排列
    const swGroups = computed(() => d.tenders.slice().sort((a, b) => a.code.localeCompare(b.code)).map(t => ({ tender: t, subs: d.subworks.filter(s => s.tenderId === t.id).sort((a, b) => a.order - b.order) })).filter(g => g.subs.length));
    const tplSw = ref('S671-5'), selTplId = ref(null), tplTab = ref('items'), edit = ref(null), previewOn = ref(false), fieldIdx = ref(-1);
    const tplList = kind => d.templates.filter(t => t.subworkId === tplSw.value && t.kind === kind && t.status === 'published').sort((a, b) => (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order));
    const dragId = ref(null), dragOver = ref(null);
    function onDragStart(e, t) { dragId.value = t.id; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.id); } catch (x) { /* ignore */ } }
    function onDragEnd() { dragId.value = null; dragOver.value = null; }
    async function onDrop(kind, target) {
      const id = dragId.value; onDragEnd(); if (!id || id === target.id) return;
      const list = tplList(kind), from = list.findIndex(x => x.id === id), to = list.findIndex(x => x.id === target.id); if (from < 0 || to < 0) return;
      const [m] = list.splice(from, 1); list.splice(to, 0, m);
      for (let i = 0; i < list.length; i++) { const t = Q.clone(list[i]); t.order = i; await Q.put('templates', t); }
      await load();
    }
    const tplHistory = computed(() => edit.value ? d.templates.filter(t => t.code === edit.value.code && t.subworkId === edit.value.subworkId && t.kind === edit.value.kind).sort((a, b) => b.version - a.version) : []);
    function pickTpl(t) { selTplId.value = t.id; edit.value = Q.clone(t); tplTab.value = t.fillMode === 'pdf' ? 'file' : 'items'; }
    const isPdf = t => !!t && t.fillMode === 'pdf';
    // 自主檢查表含 ☆停留點時不可改為 PDF（PDF 無逐項判定，無法申請會驗）
    const pdfBlockedHolds = t => t && t.kind === 'self' ? t.items.filter(i => i.hold) : [];
    watch(() => edit.value && edit.value.fillMode, m => {
      if (m === 'pdf' && pdfBlockedHolds(edit.value).length) { edit.value.fillMode = 'online'; toast(`此表含 ${pdfBlockedHolds(edit.value).length} 個 ☆停留點，PDF 範本無法逐項判定與申請會驗；請維持線上表單，或先取消停留點勾選`, true); return; }
      if (m === 'pdf') tplTab.value = 'file'; else if (tplTab.value === 'file') tplTab.value = 'items';
    });
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
    function onType(it) { if (it.type === 'number' && !it.fields.length) addField(it); if (it.type !== 'linked') it.linked = ''; else if (!it.linked) it.linked = (linkOpts.value[0] || {}).code || ''; }
    // 連結表單選項：同分項工程、已發布的其他自主檢查表（取代寫死的表5-4～5-9）
    const linkOpts = computed(() => !edit.value ? [] : [...new Map(d.templates.filter(t => t.kind === 'self' && t.status === 'published' && t.subworkId === edit.value.subworkId && t.code !== edit.value.code).map(t => [t.code, { code: t.code, name: t.name }])).values()]);
    const adminUser = computed(() => d.users.find(u => u.role === '系統管理員') || { name: '系統管理員', org: '' });
    function finalizeItems(t) {
      const order = { pre: 0, during: 1, post: 2 };
      t.items = t.items.map((x, i) => [x, i]).sort((a, b) => order[a[0].stage] - order[b[0].stage] || a[1] - b[1]).map(x => x[0]);
      t.items.forEach((x, i) => { x.no = i + 1; if (t.kind === 'self' || !x.srcNo) x.srcNo = x.srcNo || x.no; if (!x.key) x.key = Q.uid('K'); });
      return t;
    }
    async function saveEdit() {
      if (!edit.value.name.trim()) return toast('請輸入表單名稱', true);
      if (edit.value.fillMode === 'pdf' && !edit.value.pdf) return toast('請上傳空白範本 PDF', true);
      if (edit.value.fillMode === 'pdf' && pdfBlockedHolds(edit.value).length) return toast('含 ☆停留點的自主檢查表不可設為 PDF', true);
      const t = finalizeItems(Q.clone(edit.value)); const asNew = editUsed.value > 0;
      const saved = await Q.saveTemplate(t, asNew); await load(); pickTpl(d.templates.find(x => x.id === saved.id));
      toast(asNew ? `已另存為 v${saved.version}，舊版紀錄保留原內容` : '範本已儲存');
    }
    function syncFromSelf() {
      const paired = d.templates.find(t => t.id === edit.value.pairedSelf); if (!paired) return toast('此抽查表未對應自主檢查表', true);
      // 永遠對應自主檢查表的「最新發布版本」，以項目永久代碼（key）比對，不受項次重排影響
      const self = d.templates.filter(t => t.kind === 'self' && t.status === 'published' && t.code === paired.code && t.subworkId === paired.subworkId).sort((a, b) => b.version - a.version)[0] || paired;
      edit.value.pairedSelf = self.id;
      let added = 0;
      self.items.forEach(si => { const hit = edit.value.items.find(x => (si.key && x.srcKey === si.key) || (!x.srcKey && x.srcNo === si.no)); if (hit) { hit.srcKey = si.key; hit.srcNo = si.no; return; } const c = Q.clone(si); c.srcNo = si.no; c.srcKey = si.key; c.key = Q.uid('K'); c.hold = false; edit.value.items.push(c); added++; });
      toast(added ? `已同步 ${added} 項` : '已與自主檢查表同步，無新增項目');
    }
    // 新增範本：先選「線上表單」或「空白範本 PDF」
    const newTplForm = ref(null);
    function newTpl(kind) { newTplForm.value = { kind, fillMode: 'online', code: kind === 'self' ? '' : 'SP-', name: '', pdf: null }; }
    async function readPdf(file) {
      if (!file) return null;
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('請選擇 PDF 檔案', true); return null; }
      if (file.size > 10 * 1048576) { toast('PDF 檔案過大（上限 10 MB）', true); return null; }
      return { name: file.name, size: file.size, data: await Q.fileToDataUrl(file), at: Date.now() };
    }
    async function onNewPdf(e) { const f = await readPdf(e.target.files[0]); if (f) { newTplForm.value.pdf = f; if (!newTplForm.value.name) newTplForm.value.name = f.name.replace(/\.pdf$/i, '').replace(/_?空白範本$/, ''); } }
    async function onEditPdf(e) { const f = await readPdf(e.target.files[0]); if (f) { edit.value.pdf = f; toast('已選擇新的 PDF，按「儲存」後生效'); } e.target.value = ''; }
    async function createTpl() {
      const f = newTplForm.value; if (!f.name.trim()) return toast('請輸入表單名稱', true);
      if (f.fillMode === 'pdf' && !f.pdf) return toast('請上傳空白範本 PDF', true);
      const sw = swById(tplSw.value);
      const t = { id: Q.uid('TP-'), tenderId: sw.tenderId, subworkId: sw.id, kind: f.kind, code: f.code.trim() || (f.kind === 'self' ? '新表' : 'SP-新'), name: f.name.trim(), version: 1, status: 'published', source: f.fillMode === 'pdf' ? '空白範本 PDF' : '', fillMode: f.fillMode, pdf: f.fillMode === 'pdf' ? f.pdf : null, items: f.fillMode === 'pdf' ? [] : [Q.I(1, 'pre', '新檢查項目', '')], used: 0 };
      await Q.put('templates', Q.ensureKeys(t)); newTplForm.value = null; await load(); pickTpl(d.templates.find(x => x.id === t.id)); toast('已建立表單範本');
    }
    // PDF 預覽（Blob URL）
    const pdfUrl = ref(''); let pdfUrlSrc = null;
    watch(() => edit.value && edit.value.pdf && edit.value.pdf.data, v => { if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value); pdfUrl.value = v ? Q.pdfBlobUrl(v) : ''; pdfUrlSrc = v; }, { immediate: true });
    function downloadFile(f) { Q.downloadPdf(f); }
    const wfCls = st => st === '已結案' ? 'ok' : st === '未開始' ? '' : 'warn';
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
    const OPT_HEAD = ['表單類型', '表號', '連結表號']; // 選填：表單類型＝自主檢查表／抽查紀錄表；連結表號＝判定類型為「連結表單」時必填
    const KIND = { 自主檢查表: 'self', 抽查紀錄表: 'spot' };
    const linkErr = (type, code, extra) => type !== 'linked' ? '' : !code ? '判定類型為「連結表單」時，須填「連結表號」' : (d.templates.some(t => t.kind === 'self' && t.status === 'published' && t.code === code) || (extra || []).includes(code)) ? '' : `連結表號「${code}」不存在（需為已發布的自主檢查表表號）`;
    function exportCsv() {
      const t = edit.value, rows = [CSV_HEAD.concat(OPT_HEAD)].concat(t.items.map(i => [t.name, Q.STAGES[i.stage], i.no, i.name, i.std, TYPES[i.type] || '選項', i.hold ? 'Y' : 'N', i.photo ? 'Y' : 'N', i.ref || '', t.kind === 'spot' ? '抽查紀錄表' : '自主檢查表', t.code, i.linked || '']));
      download(`${t.code}_${t.name}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
    }

    /* ---------- 匯入檢查項目（到目前編輯中的範本）---------- */
    const itemImp = ref(null);
    const ITEM_REQ = ['階段', '檢查項目', '判定類型'];
    function openItemImp() { itemImp.value = { fileName: '', rows: [], groups: [], sel: '', mode: 'append', err: '', done: false }; }
    function itemSample() {
      const t = edit.value; return [CSV_HEAD.concat(OPT_HEAD)].concat((t.items.length ? t.items : [Q.I(1, 'pre', '施工圖', '是否核准')]).map(i => [t.name, Q.STAGES[i.stage], i.no, i.name, i.std, TYPES[i.type] || '選項', i.hold ? 'Y' : 'N', i.photo ? 'Y' : 'N', i.ref || '', t.kind === 'spot' ? '抽查紀錄表' : '自主檢查表', t.code, i.linked || '']));
    }
    function parseItemSheets(sheets) {
      const m = itemImp.value; m.err = ''; m.rows = []; let usable = 0, lastMiss = '';
      sheets.forEach(sh => {
        const rows = sh.rows.filter(r => r.some(x => String(x).trim() !== '')); if (rows.length < 2) return;
        const head = rows[0].map(x => String(x).trim()), miss = ITEM_REQ.filter(h => !head.includes(h));
        if (miss.length) { lastMiss = `工作表「${sh.name}」缺少欄位：` + miss.join('、'); return; }
        usable++; const ix = h => head.indexOf(h), cell = (r, h) => ix(h) < 0 ? '' : String(r[ix(h)] == null ? '' : r[ix(h)]).trim();
        rows.slice(1).forEach((r, k) => {
          const errs = [], stage = SR[cell(r, '階段')], type = RT[cell(r, '判定類型')], ref = cell(r, '引用文件編號');
          if (!stage) errs.push('階段須為 施工前／施工中／施工後');
          if (!type) errs.push('判定類型「' + cell(r, '判定類型') + '」不在代碼表內（選項／數值／照片／文字／連結表單）');
          if (!cell(r, '檢查項目')) errs.push('檢查項目不可空白');
          if (ref && !d.docs.find(x => x.code === ref)) errs.push('引用文件編號「' + ref + '」不存在於參考文件庫');
          const lk = cell(r, '連結表號'), le = linkErr(type, lk); if (le) errs.push(le);
          m.rows.push({ line: k + 2, sheet: sh.name, group: cell(r, '範本名稱') || '（未命名）', stage, type, linked: lk, name: cell(r, '檢查項目'), std: ix('檢查標準') < 0 ? '' : String(r[ix('檢查標準')] == null ? '' : r[ix('檢查標準')]), hold: /^y/i.test(cell(r, '停留點')), photo: /^y/i.test(cell(r, '必填')), ref, stageText: cell(r, '階段'), typeText: cell(r, '判定類型'), errs });
        });
      });
      if (!usable) { m.err = lastMiss || '沒有資料列，請確認第一列為欄位標題'; return; }
      m.groups = [...new Set(m.rows.map(r => r.group))]; m.sel = m.groups[0];
    }
    function downloadItemSample() { writeXlsx(`${edit.value.code}_匯入樣本.xlsx`, itemSample(), edit.value.code); }
    function onItemFile(e) {
      const f = e.target.files[0]; if (!f) return; const m = itemImp.value; m.fileName = f.name; m.rows = []; m.groups = []; m.err = ''; const rd = new FileReader();
      if (/\.xlsx?$/i.test(f.name)) {
        rd.onload = () => { try { const wb = XLSX.read(rd.result, { type: 'array' }); parseItemSheets(wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }) }))); } catch (ex) { m.err = '無法讀取 Excel：' + ex.message; } };
        rd.readAsArrayBuffer(f);
      } else rd.onload = () => parseItemSheets([{ name: 'CSV', rows: parseCsv(String(rd.result).replace(/^\ufeff/, '')) }]), rd.readAsText(f, 'utf-8');
    }
    const itemImpRows = computed(() => itemImp.value ? itemImp.value.rows.filter(r => r.group === itemImp.value.sel) : []);
    const itemImpBad = computed(() => itemImpRows.value.filter(r => r.errs.length).length);
    function doItemImp() {
      const m = itemImp.value, ok = itemImpRows.value.filter(r => !r.errs.length); if (!ok.length) return toast('沒有可匯入的列', true);
      const items = ok.map(r => Q.I(0, r.stage, r.name, r.std, { type: r.type, hold: r.hold, photo: r.photo || r.type === 'photo', ref: r.ref, fields: r.type === 'number' ? [Q.F('v', '實測值', '', null, null)] : [], linked: r.type === 'linked' ? r.linked : '' }));
      edit.value.items = m.mode === 'replace' ? items : edit.value.items.concat(items);
      toast(`已匯入 ${items.length} 項${itemImpBad.value ? `（略過 ${itemImpBad.value} 列錯誤）` : ''}，請按「儲存」生效`); itemImp.value = null;
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
        const idx = Object.fromEntries(CSV_HEAD.concat(OPT_HEAD).map(h => [h, head.indexOf(h)])), cell = (r, h) => idx[h] < 0 ? '' : String(r[idx[h]] == null ? '' : r[idx[h]]).trim();
        rows.slice(1).forEach((r, k) => {
          const g = cell(r, '範本名稱') || '（未命名）', errs = [];
          const stage = SR[cell(r, '階段')], type = RT[cell(r, '判定類型')], ref = cell(r, '引用文件編號');
          if (!stage) errs.push('階段須為 施工前／施工中／施工後');
          if (!type) errs.push('判定類型「' + cell(r, '判定類型') + '」不在代碼表內（選項／數值／照片／文字／連結表單）');
          if (!cell(r, '檢查項目')) errs.push('檢查項目不可空白');
          if (ref && !d.docs.find(x => x.code === ref)) errs.push('引用文件編號「' + ref + '」不存在於參考文件庫');
          const kt = cell(r, '表單類型'); if (kt && !KIND[kt]) errs.push(`表單類型「${kt}」須為 自主檢查表／抽查紀錄表`);
          const grp = (groups[g] = groups[g] || { name: g, rows: [], kind: 'self', code: '' }); if (KIND[kt]) grp.kind = KIND[kt]; if (cell(r, '表號') && !grp.code) grp.code = cell(r, '表號');
          grp.rows.push({ line: k + 2, sheet: sh.name, stage, type, linked: cell(r, '連結表號'), name: cell(r, '檢查項目'), std: String(r[idx['檢查標準']] == null ? '' : r[idx['檢查標準']]), hold: /^y/i.test(cell(r, '停留點')), photo: /^y/i.test(cell(r, '必填')), ref, raw: r, idx, errs });
        });
      });
      if (!usable) { imp.err = lastMiss || '沒有資料列，請上傳 Excel／CSV 或貼上內容'; return; }
      const newCodes = Object.values(groups).map(g => g.code).filter(Boolean);
      Object.values(groups).forEach(g => g.rows.forEach(r => { const le = linkErr(r.type, r.linked, newCodes); if (le) r.errs.push(le); }));
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
    const SAMPLE_ROWS = () => [CSV_HEAD.concat(OPT_HEAD), ['表5-6 鋼筋籠自主檢查表', '施工前', 1, '施工圖', '是否核准', '選項', 'Y', 'Y', 'CF671-PL-0032'], ['表5-6 鋼筋籠自主檢查表', '施工中', 2, '焊條使用是否符合要求', '使用 AWS D1.4 E8016', '選項', 'N', 'N', ''], ['表5-6 鋼筋籠自主檢查表', '施工中', 3, '鋼筋剪力筋是否依設計數量安放', '依施工圖標示', 'Y/N', 'N', 'N', ''], ['表5-6 鋼筋籠自主檢查表', '施工中', 4, '鋼筋籠端板是否牢固', '端板厚度 6mm', '數值', 'N', 'N', 'CF671-DW-9999'], ['表5-6 鋼筋籠自主檢查表', '施工後', 5, '場地清理', '是否清理完成', '選項', 'N', 'N', '']];
    function sampleCsv() { return SAMPLE_ROWS().map(r => r.map(csvCell).join(',')).join('\r\n'); }
    function loadSample() { imp.fileName = '範本匯入樣本.xlsx'; imp.sheets = [{ name: '範本', rows: SAMPLE_ROWS() }]; imp.step = 2; validate(); }
    function writeXlsx(name, rows, sheetName) {
      const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = CSV_HEAD.concat(OPT_HEAD).map((h, i) => ({ wch: [26, 8, 6, 28, 36, 10, 8, 6, 16, 12, 8, 10][i] }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheetName || '範本'); XLSX.writeFile(wb, name);
    }
    function downloadSample() { writeXlsx('範本匯入樣本.xlsx', SAMPLE_ROWS()); }
    function exportXlsx() {
      const t = edit.value; writeXlsx(`${t.code}_${t.name}.xlsx`, [CSV_HEAD.concat(OPT_HEAD)].concat(t.items.map(i => [t.name, Q.STAGES[i.stage], i.no, i.name, i.std, TYPES[i.type] || '選項', i.hold ? 'Y' : 'N', i.photo ? 'Y' : 'N', i.ref || '', t.kind === 'spot' ? '抽查紀錄表' : '自主檢查表', t.code, i.linked || ''])), t.code);
    }
    // 建立新範本時：同一分項工程已有相同表號 → 須改用「匯入為新版本」
    const impDup = g => imp.mode === 'new' && !!g.code && d.templates.some(t => t.status === 'published' && t.subworkId === imp.targetSw && t.kind === g.kind && t.code === g.code);
    const impOk = computed(() => imp.groups.filter(g => !g.bad && !impDup(g)));
    async function doImport() {
      let n = 0;
      for (const g of impOk.value) {
        const items = g.rows.map((r, i) => Q.I(i + 1, r.stage, r.name, r.std, { type: r.type, hold: r.hold, photo: r.photo, ref: r.ref || '', fields: r.type === 'number' ? [Q.F('v', '實測值', '', null, null)] : [], linked: r.type === 'linked' ? r.linked : '' }));
        if (imp.mode === 'version' && imp.existing) {
          const old = d.templates.find(t => t.id === imp.existing); const nt = Q.clone(old); nt.items = items; await Q.saveTemplate(nt, true);
        } else {
          const sw = swById(imp.targetSw);
          let code = g.code; if (!code) { let k = 1; while (d.templates.some(t => t.subworkId === sw.id && t.code === `IMP-${k}`)) k++; code = `IMP-${k}`; }
          await Q.put('templates', Q.ensureKeys({ id: Q.uid('TP-'), tenderId: sw.tenderId, subworkId: sw.id, kind: g.kind || 'self', code, name: g.name, version: 1, status: 'published', source: '匯入：' + (imp.fileName || '貼上內容'), fillMode: 'online', items, used: 0 }));
        }
        n++;
      }
      await load(); imp.step = 4; imp.done = n;
    }
    function impReset() { Object.assign(imp, { step: 1, text: '', fileName: '', groups: [], err: '', sheets: [] }); }

    /* ---------- 其他 ---------- */
    const docForm = ref(null), userForm = ref(null);
    // 參考文件：可上傳檔案（PDF、Word、Excel、圖檔等，上限 20 MB），現場作業可下載
    function newDoc() { docForm.value = { id: '', code: '', name: '', note: '', file: null, isNew: true }; }
    function editDoc(x) { docForm.value = Object.assign(Q.clone(x), { isNew: false }); }
    async function onDocFile(e) {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      if (f.size > 20 * 1048576) return toast('檔案過大（上限 20 MB）', true);
      docForm.value.file = { name: f.name, size: f.size, type: f.type, data: await Q.fileToDataUrl(f), at: Date.now() };
      if (!docForm.value.name.trim()) docForm.value.name = f.name.replace(/\.[^.]+$/, '');
    }
    async function saveDoc() {
      const x = docForm.value; if (!x.code.trim()) return toast('請輸入文件編號', true); if (!x.name.trim()) return toast('請輸入文件名稱', true);
      if (x.isNew && d.docs.some(o => o.code === x.code.trim())) return toast('文件編號已存在', true);
      const rec = { id: x.isNew ? x.code.trim() : x.id, code: x.isNew ? x.code.trim() : x.code, name: x.name.trim(), note: x.note || '', file: x.file || null };
      await Q.put('docs', rec); docForm.value = null; await load(); toast(rec.file ? '已儲存，現場作業可下載此文件' : '已儲存（尚未上傳檔案）');
    }
    async function saveUser() { const x = userForm.value; if (!x.name.trim()) return toast('請輸入姓名', true); if (!x.id) x.id = Q.uid('U'); await Q.put('users', x); userForm.value = null; await load(); }
    async function delRow(store, id) {
      if (store === 'docs') { const used = d.templates.filter(t => t.status === 'published' && (t.items || []).some(i => i.ref === id)); if (used.length) return toast(`文件 ${id} 仍被 ${used.length} 張範本引用（${used.slice(0, 3).map(t => '表' + t.code).join('、')}${used.length > 3 ? '…' : ''}），請先移除引用`, true); }
      if (!confirm('確定刪除？')) return; await Q.del(store, id); await load();
    }
    async function saveParams() {
      const p = d.params; ['holdAdvanceHours', 'replyHours', 'photoMaxKB', 'defectDueDays'].forEach(k => { p[k] = Number(p[k]) || 0; });
      await Q.put('meta', Object.assign({ id: 'params' }, p)); toast('參數已儲存');
    }
    async function resetDemo() { if (!confirm('將清除所有資料並還原示範資料，確定？')) return; await Q.seed(true); await load(); toast('已還原示範資料'); }
    const navItems = [['dashboard', '查驗總覽'], ['g', '查驗作業'], ['holds', '停留點會驗', 'badge'], ['selfchecks', '自主檢查紀錄'], ['spots', '抽查紀錄'], ['defects', '缺失追蹤', 'dbadge'], ['g', '基本資料'], ['projects', '標案與分項工程'], ['templates', '表單範本'], ['import', '範本匯入'], ['docs', '參考文件'], ['g', '系統'], ['users', '帳號與權限'], ['params', '參數設定']];
    // 側邊選單：分組可收合（狀態記在 localStorage）
    const navTree = (() => { const t = []; navItems.forEach(n => { if (n[0] === 'g') t.push({ group: n[1], items: [] }); else if (t.length) t[t.length - 1].items.push(n); else t.push({ link: n }); }); return t; })();
    const collapsed = reactive((() => { try { return JSON.parse(localStorage.getItem('qms-nav-collapsed') || '{}'); } catch (e) { return {}; } })());
    function toggleGroup(name) { collapsed[name] = !collapsed[name]; try { localStorage.setItem('qms-nav-collapsed', JSON.stringify(collapsed)); } catch (e) { /* ignore */ } }
    watch(page, p => { const g = navTree.find(x => x.group && x.items.some(i => i[0] === p)); if (g && collapsed[g.group]) toggleGroup(g.group); }, { immediate: true });
    const titles = Object.fromEntries(navItems.filter(n => n[0] !== 'g').map(n => [n[0], n[1]]));
    const todayStr = () => { const t = new Date(); return `${Q.fmtD(t)}（${'日一二三四五六'[t.getDay()]}）`; };

    onMounted(async () => {
      await Q.ready; await load(); const l = tplList('self').sort((a, b) => b.items.length - a.items.length)[0]; if (l) pickTpl(l);
      Q.onChange(async () => { await load(); });
      setInterval(async () => { await Q.tickOverdue(); await load(); }, 30000);
    });

    return {
      Q, d, now, loaded, page, menuOpen, toastMsg, toastNg, toast, go, tenderById, swById, tenderFilter, supervisors, reqCls, rel, openReqs, overdueReqs, openDefects, overdueDefects, weekHolds, spotRate, kpiSelf, todayAgenda, tplOf, usedCount,
      progTender, progFilter, progRows, progCount, holdTab, holdTabs, holdCount, holdList, holdByDate, selReqId, selReq, calView, sched, reqChips, lockedAfter, hoursBefore, doSchedule, doReject, doStart, doCancel,
      showSC, showSP, itemsOf, judgeText, valuesText, spotCount, defCls, defText, defTab, defList, defAct, defShow, defReview,
      selTenderId, selTender, treeRoot, treeOpen, swPick, treeAll, pickTender, pickSw, swSearch, swStatus, swPage, swPages, swPaged, swAll, swTplText, swHold, tenderForm, swForm, saveTender, saveSw, moveSw, delSw, newTender,
      tplSw, swGroups, selTplId, tplTab, edit, previewOn, fieldIdx, tplList, tplHistory, pickTpl, editUsed, editStages, isPdf, newTplForm, onNewPdf, onEditPdf, createTpl, pdfUrl, downloadFile, wfCls, readPdf, TYPES, holdN, addItem, delItem, moveItem, addField, onType, saveEdit, delTpl, syncFromSelf, newTpl, exportCsv, exportXlsx, dragId, dragOver, onDragStart, onDragEnd, onDrop, itemImp, openItemImp, itemSample, downloadItemSample, onItemFile, itemImpRows, itemImpBad, doItemImp,
      imp, impDup, linkOpts, adminUser, validate, onFile, sampleCsv, loadSample, downloadSample, impOk, doImport, impReset, download,
      docForm, userForm, saveDoc, newDoc, editDoc, onDocFile, saveUser, delRow, saveParams, resetDemo, navItems, navTree, collapsed, toggleGroup, titles, todayStr
    };
  }
}).mount('#app');
