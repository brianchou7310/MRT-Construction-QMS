/* 現場作業頁 (RWD：平板／手機) - Vue 3 全域版 + IndexedDB */
const { createApp, reactive, ref, computed, watch, onMounted, nextTick } = Vue;

createApp({
  setup() {
    const Q = QMS;
    const d = reactive({ tenders: [], subworks: [], templates: [], selfChecks: [], requests: [], spotChecks: [], defects: [], docs: [], params: {} });
    const loaded = ref(false), now = ref(Date.now());
    const view = ref('todo'), todoTab = ref('hold'), tenderSel = ref('all');
    const role = ref((() => { try { return localStorage.getItem('qms2-role') || 'contractor'; } catch (e) { return 'contractor'; } })());
    const isSup = computed(() => role.value !== 'contractor'), isDirector = computed(() => role.value === 'director');
    watch(role, v => { try { localStorage.setItem('qms2-role', v); } catch (e) { /* ignore */ } });
    const me = computed(() => isDirector.value ? { name: '示範工務所主任', org: '捷運局工務所', title: '捷運局工務所主任' } : isSup.value ? { name: '示範工務所同仁', org: '捷運局工務所', title: '捷運局工務所同仁' } : { name: '示範品管', org: '大陸工程股份有限公司', title: '廠商品管人員' });
    const wide = ref(window.matchMedia('(min-width: 900px)').matches);
    window.matchMedia('(min-width: 900px)').addEventListener('change', e => { wide.value = e.matches; });
    const toastMsg = ref(''), toastNg = ref(false); let tt;
    function toast(m, ng) { toastMsg.value = m; toastNg.value = !!ng; clearTimeout(tt); tt = setTimeout(() => { toastMsg.value = ''; }, 2800); }

    async function load() {
      const names = ['tenders', 'subworks', 'templates', 'selfChecks', 'requests', 'spotChecks', 'defects', 'docs'];
      const res = await Promise.all(names.map(s => Q.all(s)).concat([Q.getParams()]));
      names.forEach((n, i) => { d[n] = res[i]; }); d.params = res[names.length]; now.value = Date.now(); loaded.value = true;
    }
    const tplOf = id => d.templates.find(t => t.id === id);
    const rel = ts => Q.relTime(ts, now.value);
    const inTender = x => tenderSel.value === 'all' || x.tenderId === tenderSel.value;
    const hh = ts => { const t = new Date(ts); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); };
    const todayLabel = computed(() => { const t = new Date(now.value); return `${t.getMonth() + 1}/${String(t.getDate()).padStart(2, '0')}（${'日一二三四五六'[t.getDay()]}）`; });

    /* ---------- 照片：壓浮水印＋壓縮 ---------- */
    let lastGps = null;
    function getGps() {
      return new Promise(res => {
        if (!navigator.geolocation) return res(lastGps);
        setTimeout(() => res(lastGps), 2000); // 使用者未回應定位授權時不卡住拍照
        navigator.geolocation.getCurrentPosition(p => { lastGps = `${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`; res(lastGps); }, () => res(lastGps), { timeout: 1500, maximumAge: 60000 });
      });
    }
    async function stamp(srcDrawFn, w, h, label) {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); srcDrawFn(g, w, h);
      const gps = await getGps(); const bar = Math.max(36, Math.round(h * 0.09)); g.fillStyle = 'rgba(15,23,42,.78)'; g.fillRect(0, h - bar, w, bar);
      g.fillStyle = '#fff'; g.font = `${Math.round(bar * 0.38)}px sans-serif`;
      g.fillText(`${Q.fmtFull(Date.now())}・${label}`, 10, h - bar * 0.55); g.fillText(`GPS ${gps || '未取得'}`, 10, h - bar * 0.12);
      const maxB = (Number(d.params.photoMaxKB) || 400) * 1024; let q = 0.85, url = c.toDataURL('image/jpeg', q);
      while (url.length * 0.75 > maxB && q > 0.2) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
      return url;
    }
    function fileToPhoto(file, label) {
      return new Promise((resolve, reject) => {
        const img = new Image(), u = URL.createObjectURL(file);
        img.onload = async () => { const s = Math.min(1, 1280 / Math.max(img.width, img.height)), w = Math.round(img.width * s), h = Math.round(img.height * s); const r = await stamp(g => g.drawImage(img, 0, 0, w, h), w, h, label); URL.revokeObjectURL(u); resolve(r); };
        img.onerror = reject; img.src = u;
      });
    }
    function pickPhoto(label, cb) {
      const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.setAttribute('capture', 'environment');
      i.onchange = async () => { if (i.files[0]) { try { cb(await fileToPhoto(i.files[0], label)); } catch (e) { toast('照片處理失敗', true); } } }; i.click();
    }
    async function demoPhoto(label, cb) {
      cb(await stamp((g, w, h) => { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#cbd5e1'); gr.addColorStop(1, '#94a3b8'); g.fillStyle = gr; g.fillRect(0, 0, w, h); g.fillStyle = '#475569'; g.font = '28px sans-serif'; g.fillText('示範照片', 20, 50); }, 640, 480, label));
    }

    /* ---------- 待辦 ---------- */
    const reqCls = r => ({ pending: 'warn', scheduled: 'blue', inspecting: 'blue', passed: 'ok', failed: 'ng', rejected: 'ng' }[r.status]);
    const todoReqs = computed(() => d.requests.filter(r => ['pending', 'scheduled', 'inspecting'].includes(r.status) && inTender(r)).sort((a, b) => a.scheduledAt - b.scheduledAt));
    const lockedCards = computed(() => d.selfChecks.filter(sc => sc.status === 'draft' && inTender(sc)).flatMap(sc => {
      const tpl = tplOf(sc.templateId); if (!tpl) return [];
      return tpl.items.filter(i => i.hold && ['none', 'failed'].includes(Q.holdState(sc, i.no))).map(i => ({ sc, i, reason: Q.lockReason(sc, tpl, i) })).filter(x => x.reason && x.reason.startsWith('待'));
    }));
    const draftSpots = computed(() => d.spotChecks.filter(s => s.status === 'draft'));
    const openDefects = computed(() => d.defects.filter(x => x.status !== 'closed' && inTender(x)));
    const todoCount = computed(() => todoReqs.value.length + lockedCards.value.length + draftSpots.value.length + openDefects.value.length);
    const holdFilter = ref('all');
    const holdsList = computed(() => d.requests.filter(r => holdFilter.value === 'all' || r.status === holdFilter.value).sort((a, b) => b.appliedAt - a.appliedAt));

    /* 請求詳情面板 */
    const selReqId = ref(null), sched = reactive({ dt: '', reason: '', rejecting: false });
    const selReq = computed(() => d.requests.find(r => r.id === selReqId.value));
    function selectReq(r) { selReqId.value = r.id; sched.dt = Q.toLocalInput(r.scheduledAt); sched.reason = ''; sched.rejecting = false; }
    const reqChips = r => {
      const sc = d.selfChecks.find(s => s.id === r.scId), tpl = sc && tplOf(sc.templateId), it = tpl && tpl.items.find(i => i.no === r.itemNo); if (!it) return [];
      return it.fields.filter(f => (r.values || {})[f.key] !== undefined && r.values[f.key] !== '').map(f => ({ label: f.label, v: r.values[f.key], unit: f.unit }));
    };
    const reqPhotos = r => { const sc = d.selfChecks.find(s => s.id === r.scId); const a = sc && sc.answers[r.itemNo]; return a && a.photos && a.photos.length ? a.photos : Array.from({ length: r.photoCount || 0 }, () => '*'); };
    const lockedAfter = r => { const sc = d.selfChecks.find(s => s.id === r.scId), tpl = sc && tplOf(sc.templateId); return tpl ? tpl.items.filter(i => i.hold && i.no > r.itemNo && Q.holdState(sc, i.no) !== 'passed').map(i => i.name) : []; };
    async function doSchedule() { const ts = Q.fromLocalInput(sched.dt); if (!ts) return toast('請選擇時間', true); const r = selReq.value; await Q.schedule(r.id, ts, me.value.name, r.status === 'scheduled'); await load(); toast('已排定並通知廠商'); }
    async function doReject() { if (!sched.reason.trim()) return toast('請填寫退回原因', true); await Q.reject(selReq.value.id, sched.reason); sched.rejecting = false; await load(); toast('已退回申請'); }
    async function doStart(r) { const sp = await Q.startInspection((r || selReq.value).id); await load(); openSpot(sp.id); }

    /* ---------- 自主檢查清單 / 新增 ---------- */
    const scList = computed(() => d.selfChecks.filter(inTender).sort((a, b) => b.updatedAt - a.updatedAt));
    const scProgress = sc => { if (sc.fillMode === 'pdf') return { n: sc.pdfFile ? 1 : 0, total: 1 }; const t = tplOf(sc.templateId); return { n: Object.values(sc.answers).filter(a => a.judge).length, total: t ? t.items.length : 0 }; };
    const newForm = ref(null), qrForm = ref(null);
    // 新增表單的三層選擇：標號 → 工項(分項工程) → 表單
    const byOrder = (a, b) => (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order);
    const tplOpts = (sid, kind) => d.templates.filter(t => t.subworkId === sid && t.kind === kind && t.status === 'published').sort((a, b) => byOrder(a, b) || b.items.length - a.items.length);
    const swOpts = (tid, kind) => d.subworks.filter(s => s.tenderId === tid && tplOpts(s.id, kind).length).sort(byOrder);
    const tenderOpts = () => d.tenders.slice().sort((a, b) => a.code.localeCompare(b.code));
    function cascade(f, kind, from) {
      if (from === 'tender') f.subworkId = (swOpts(f.tenderId, kind)[0] || {}).id || '';
      if (from !== 'tpl') f.templateId = (tplOpts(f.subworkId, kind)[0] || {}).id || '';
    }
    function newFormInit(kind, unit) {
      const ts = tenderOpts().filter(x => swOpts(x.id, kind).length), t = ts.find(x => x.id === tenderSel.value) || ts[0] || tenderOpts()[0] || {}; const f = { tenderId: t.id || '', subworkId: '', templateId: '', unit: unit || '', location: '' }; cascade(f, kind, 'tender'); return f;
    }
    function openNew(unit) { newForm.value = newFormInit('self', unit); }
    async function createSc() {
      const f = newForm.value; if (!f.unit.trim()) return toast('請輸入單元編號', true); if (!f.tenderId || !f.subworkId || !f.templateId) return toast('請依序選擇標號、工項、表單', true);
      const sc = await Q.newSelfCheck({ templateId: f.templateId, unit: f.unit.trim().toUpperCase(), location: f.location.trim() }); newForm.value = null; await load(); openSc(sc.id);
    }
    function scanQr() {
      const code = (qrForm.value.code || '').trim().toUpperCase(); if (!code) return toast('請輸入單元編號', true); qrForm.value = null;
      const sc = d.selfChecks.find(s => s.unit === code && s.status === 'draft');
      if (sc) { openSc(sc.id); toast('已掃描單元 ' + code); } else { openNew(code); }
    }

    /* ---------- 自主檢查表單 ---------- */
    const cur = ref(null), stageTab = ref('pre'), itemNo = ref(1), saveMsg = ref(''), docShow = ref(null), linkShow = ref(null), applyForm = ref(null);
    let saveTimer = null;
    const curTpl = computed(() => cur.value && tplOf(cur.value.templateId));
    const readonly = computed(() => !cur.value || cur.value.status === 'signed' || isSup.value);
    const stageList = computed(() => curTpl.value ? Q.stageItems(curTpl.value, stageTab.value) : []);
    const curItem = computed(() => curTpl.value && (curTpl.value.items.find(i => i.no === itemNo.value) || curTpl.value.items[0]));
    const shownItems = computed(() => wide.value ? (curItem.value ? [curItem.value] : []) : stageList.value);
    const judged = computed(() => cur.value ? Object.values(cur.value.answers).filter(a => a.judge).length : 0);
    const total = computed(() => curTpl.value ? curTpl.value.items.length : 0);
    const stageStat = st => { const l = curTpl.value ? Q.stageItems(curTpl.value, st) : []; return `${l.filter(i => ans(i.no).judge).length}/${l.length}`; };
    const stageDone = st => curTpl.value && Q.stageDone(cur.value, curTpl.value, st);
    function ans(no) { const a = cur.value && cur.value.answers[no]; return a || { judge: null, values: {}, photos: [], note: '' }; }
    function ensure(no) { if (!cur.value.answers[no]) cur.value.answers[no] = { judge: null, values: {}, photos: [], note: '' }; return cur.value.answers[no]; }
    const lockOf = it => cur.value && curTpl.value ? Q.lockReason(cur.value, curTpl.value, it) : null;
    const hstate = it => Q.holdState(cur.value, it.no);
    const hreq = it => d.requests.find(r => r.id === ((cur.value.hold[it.no] || {}).requestId));
    const itemEditable = it => !readonly.value && !lockOf(it) && ['none', 'failed'].includes(hstate(it));
    const sugg = it => Q.suggest(it, ensure(it.no).values);
    const itemIcon = it => { const j = ans(it.no).judge; return j === 'ok' ? '○' : j === 'ng' ? '╳' : j === 'na' ? '╱' : ''; };

    function queueSave() { if (!cur.value || cur.value.status === 'signed') return; saveMsg.value = '儲存中…'; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 500); }
    async function flush() {
      clearTimeout(saveTimer); saveTimer = null; if (!cur.value || cur.value.status === 'signed') return;
      await Q.saveSelf(Q.clone(cur.value)); const t = new Date(); saveMsg.value = `已自動儲存 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}・離線時暫存於本機，連線後自動上傳`;
    }
    async function openSc(id) {
      const sc = await Q.get('selfChecks', id);
      if (sc.fillMode === 'pdf') return openPdf('self', sc);
      cur.value = reactive(Q.clone(sc)); stageTab.value = 'pre'; saveMsg.value = '';
      const t0 = tplOf(sc.templateId); if (t0) t0.items.forEach(i => { if (!cur.value.answers[i.no]) cur.value.answers[i.no] = { judge: null, values: {}, photos: [], note: '' }; });
      const t = tplOf(sc.templateId); if (t) { const first = t.items.find(i => !(sc.answers[i.no] || {}).judge) || t.items[0]; itemNo.value = first.no; stageTab.value = first.stage; }
      view.value = 'form'; window.scrollTo(0, 0);
    }
    function gotoItem(it) { itemNo.value = it.no; stageTab.value = it.stage; }
    function setStage(st) { stageTab.value = st; const l = Q.stageItems(curTpl.value, st); const f = l.find(i => !ans(i.no).judge) || l[0]; if (f) itemNo.value = f.no; }
    function step(dir) { const its = curTpl.value.items, i = its.findIndex(x => x.no === itemNo.value) + dir; if (i >= 0 && i < its.length) gotoItem(its[i]); }
    function setJudge(it, j) {
      if (readonly.value) return toast(isSup.value ? '工務所同仁身分僅能檢視自主檢查表' : '表單已簽認，不可修改', true);
      const lk = lockOf(it); if (lk) return toast('項目已鎖定：' + lk, true);
      if (!['none', 'failed'].includes(hstate(it))) return toast('已申請會驗，判定不可更改', true);
      const a = ensure(it.no);
      if (a.judge === j) { a.judge = null; queueSave(); return; }
      if (j === 'ok') {
        if (it.type === 'linked' && !cur.value.linked[it.linked]) return toast(`請先完成並確認表${it.linked}，才能判定 ○`, true);
        if (it.photo && !a.photos.length) return toast('此項必須拍照後才能判定 ○', true);
      }
      a.judge = j; queueSave();
      if (j === 'ng') toast('已判定缺失；送出後系統將自動建立缺失追蹤');
      if (wide.value && j && curTpl.value) { /* 判定後不自動跳項，讓使用者可申請會驗 */ }
    }
    function addPhoto(it) { if (!itemEditable(it)) return toast('此項目目前不可編輯', true); pickPhoto(`${cur.value.tenderCode}・單元 ${cur.value.unit}・${it.name}`, url => { ensure(it.no).photos.push(url); queueSave(); }); }
    function addDemoPhoto(it) { if (!itemEditable(it)) return toast('此項目目前不可編輯', true); demoPhoto(`${cur.value.tenderCode}・單元 ${cur.value.unit}・${it.name}`, url => { ensure(it.no).photos.push(url); queueSave(); }); }
    function delPhoto(it, i) { if (!itemEditable(it)) return; ensure(it.no).photos.splice(i, 1); const a = ensure(it.no); if (it.photo && !a.photos.length && a.judge === 'ok') a.judge = null; queueSave(); }
    function useSuggest(it) { const s = sugg(it); if (s) setJudge(it, s); }
    function markLinked(code) { cur.value.linked[code] = true; linkShow.value = null; queueSave(); toast(`表${code} 已完成`); }
    function confirmQr() { cur.value.qrConfirmed = true; queueSave(); toast(`已掃描確認單元 ${cur.value.unit} 位置`); }

    /* 申請停留點會驗 */
    function canApply(it) { const a = ans(it.no); return it.hold && a.judge === 'ok' && (!it.photo || a.photos.length) && ['none', 'failed'].includes(hstate(it)) && !readonly.value && !lockOf(it); }
    function openApply(it) { applyForm.value = { itemNo: it.no, dt: Q.toLocalInput(Q.atDay(1, 9, 0)), reason: '', location: cur.value.location }; }
    const applyShort = computed(() => applyForm.value ? (Q.fromLocalInput(applyForm.value.dt) - now.value) < d.params.holdAdvanceHours * Q.H : false);
    const applyHours = computed(() => applyForm.value ? Math.max(0, Math.round((Q.fromLocalInput(applyForm.value.dt) - now.value) / Q.H)) : 0);
    async function submitApply() {
      const f = applyForm.value; const ts = Q.fromLocalInput(f.dt); if (!ts) return toast('請選擇預定會驗時間', true);
      try { await flush(); const r = await Q.applyHold(cur.value.id, f.itemNo, { scheduledAt: ts, reason: f.reason, location: f.location }); const sc = await Q.get('selfChecks', cur.value.id); cur.value.hold = sc.hold; applyForm.value = null; await load(); toast(`已送出會驗申請 ${r.id}，Email 已通知監造`); } catch (e) { toast(e.message, true); }
    }
    const holdText = it => Q.HOLD_TEXT[hstate(it)];

    /* 送出前總覽 */
    const summary = computed(() => { const a = cur.value ? Object.values(cur.value.answers) : []; return { ok: a.filter(x => x.judge === 'ok').length, ng: a.filter(x => x.judge === 'ng').length, na: a.filter(x => x.judge === 'na').length, photos: a.reduce((n, x) => n + (x.photos || []).length, 0) }; });
    const holdItems = computed(() => curTpl.value ? curTpl.value.items.filter(i => i.hold) : []);
    const attachCodes = computed(() => cur.value ? Object.keys(cur.value.linked).filter(k => cur.value.linked[k]).sort() : []);
    const canSubmit = computed(() => judged.value === total.value && total.value > 0);
    async function goSign() {
      if (!canSubmit.value) return toast(`尚有 ${total.value - judged.value} 項未判定`, true);
      if (summary.value.ng && !cur.value.recovery) { stageTab.value = 'sum'; return toast('有缺失項目，請先選擇缺失複查結果', true); }
      await flush(); openSign('self', cur.value.id);
    }
    function finishStage() {
      const order = ['pre', 'during', 'post', 'sum'], i = order.indexOf(stageTab.value); if (!stageDone(stageTab.value)) return toast('本階段尚有項目未判定', true);
      if (order[i + 1] === 'sum') { stageTab.value = 'sum'; } else setStage(order[i + 1]);
    }
    const stageTabs = [['pre', '施工前'], ['during', '施工中'], ['post', '施工後'], ['sum', '總覽']];
    const stageNext = computed(() => ({ pre: '完成施工前檢查，進入施工中', during: '完成施工中，進入施工後', post: '送出前總覽 ›', sum: '' })[stageTab.value]);
    async function leaveForm() { await flush(); cur.value = null; view.value = 'checks'; await load(); }

    /* ---------- 抽查紀錄（與自主檢查相同：分階段、逐項判定）---------- */
    const sp = ref(null), spStage = ref('pre'), spItemNo = ref(1), spSaveMsg = ref(''), spNew = ref(null);
    const spTpl = computed(() => sp.value && tplOf(sp.value.templateId));
    const spReq = computed(() => sp.value && d.requests.find(r => r.id === sp.value.requestId));
    const spSc = computed(() => sp.value && d.selfChecks.find(s => s.id === sp.value.scId));
    const spEditable = computed(() => sp.value && sp.value.status !== 'signed' && isSup.value);
    const spStageList = computed(() => spTpl.value ? Q.stageItems(spTpl.value, spStage.value) : []);
    const spCurItem = computed(() => spTpl.value && (spTpl.value.items.find(i => i.no === spItemNo.value) || spTpl.value.items[0]));
    const spShown = computed(() => wide.value ? (spCurItem.value ? [spCurItem.value] : []) : spStageList.value);
    const spA = no => (sp.value && sp.value.answers[no]) || { judge: null, values: {}, photos: [], note: '' };
    const spJudged = computed(() => sp.value ? Object.values(sp.value.answers).filter(a => a.judge).length : 0);
    const spTotal = computed(() => spTpl.value ? spTpl.value.items.length : 0);
    const spSummary = computed(() => { const a = sp.value ? Object.values(sp.value.answers) : []; return { ok: a.filter(x => x.judge === 'ok').length, ng: a.filter(x => x.judge === 'ng').length, na: a.filter(x => x.judge === 'na').length, none: a.filter(x => !x.judge).length, photos: a.reduce((n, x) => n + (x.photos || []).length, 0) }; });
    const spStageStat = st => { const l = spTpl.value ? Q.stageItems(spTpl.value, st) : []; return `${l.filter(i => spA(i.no).judge).length}/${l.length}`; };
    const spSelfVals = it => { const a = spSc.value && spSc.value.answers[it.srcNo || it.no]; return (a && a.values) || {}; };
    const spSugg = it => Q.suggest(it, spA(it.no).values);
    const spArea = computed(() => { const l = Number(sp.value && sp.value.calc.length), dp = Number(sp.value && sp.value.calc.depth); return l && dp ? (l * dp).toFixed(2) : ''; });
    const spLocked = computed(() => spReq.value ? lockedAfter(spReq.value) : []);
    const spList = computed(() => d.spotChecks.filter(x => tenderSel.value === 'all' || x.tenderId === tenderSel.value).sort((a, b) => b.createdAt - a.createdAt));
    const spProgress = x => x.fillMode === 'pdf' ? { n: x.pdfFile ? 1 : 0, total: 1 } : ({ n: Object.values(x.answers || {}).filter(a => a.judge).length, total: Object.keys(x.answers || {}).length });
    let spTimer = null;
    function spSave() { if (!sp.value || sp.value.status === 'signed') return; spSaveMsg.value = '儲存中…'; clearTimeout(spTimer); spTimer = setTimeout(spFlush, 500); }
    async function spFlush() { clearTimeout(spTimer); spTimer = null; if (!sp.value || sp.value.status === 'signed') return; await Q.put('spotChecks', Q.clone(sp.value)); spSaveMsg.value = '已自動儲存 ' + hh(Date.now()); }
    async function openSpot(id) {
      await Q.migrateSpots(); const rec = await Q.get('spotChecks', id);
      if (rec.fillMode === 'pdf') return openPdf('spot', rec);
      sp.value = reactive(Q.clone(rec)); spSaveMsg.value = '';
      const t = tplOf(rec.templateId); const first = t && (t.items.find(i => i.no === rec.focusNo) || t.items[0]);
      if (first) { spItemNo.value = first.no; spStage.value = first.stage; } view.value = 'spot'; window.scrollTo(0, 0);
    }
    function spGoto(it) { spItemNo.value = it.no; spStage.value = it.stage; }
    function spSetStage(st) { spStage.value = st; const l = Q.stageItems(spTpl.value, st); const f = l.find(i => i.no === sp.value.focusNo) || l.find(i => !spA(i.no).judge) || l[0]; if (f) spItemNo.value = f.no; }
    function spJudge(it, j) {
      if (!spEditable.value) return toast(isSup.value ? '表單已簽認，不可修改' : '抽查紀錄由監造人員填寫（請於「我的」切換為監造）', true);
      const a = sp.value.answers[it.no]; if (a.judge === j) { a.judge = null; spSave(); return; }
      if (j === 'ok' && it.photo && !a.photos.length) return toast('此項必須拍照後才能判定 ○', true);
      a.judge = j; spSave(); if (j === 'ng') toast('已判定缺失；簽認後系統將自動建立缺失追蹤');
    }
    function spUseSuggest(it) { const s = spSugg(it); if (s) spJudge(it, s); }
    const spLabel = it => `${sp.value.tenderCode}・單元 ${sp.value.unit}・${it.name}`;
    function spPhoto(it) { if (!spEditable.value) return toast('目前不可編輯', true); pickPhoto(spLabel(it), u => { sp.value.answers[it.no].photos.push(u); spSave(); }); }
    function spDemoPhoto(it) { if (!spEditable.value) return toast('目前不可編輯', true); demoPhoto(spLabel(it), u => { sp.value.answers[it.no].photos.push(u); spSave(); }); }
    function spDelPhoto(it, i) { if (!spEditable.value) return; const a = sp.value.answers[it.no]; a.photos.splice(i, 1); if (it.photo && !a.photos.length && a.judge === 'ok') a.judge = null; spSave(); }
    async function spGoSign() {
      if (!spEditable.value) return toast('抽查紀錄由監造人員填寫', true);
      const f = sp.value.focusNo; if (f && !sp.value.answers[f].judge) { spGoto(spTpl.value.items.find(i => i.no === f)); return toast('請先判定本次會驗項目：' + sp.value.title, true); }
      if (!f && !spJudged.value) return toast('請至少抽查並判定一個項目', true);
      Q.autoNa(sp.value); await spFlush(); openSign('spot', sp.value.id);
    }
    async function leaveSpot() { await spFlush(); sp.value = null; view.value = 'spots'; await load(); }
    function openSpotNew() { spNew.value = newFormInit('spot'); }
    async function createSpot() {
      const f = spNew.value; if (!f.tenderId || !f.subworkId || !f.templateId) return toast('請依序選擇標號、工項、表單', true); if (!f.unit.trim()) return toast('請輸入單元編號', true);
      const rec = await Q.newSpotCheck({ templateId: f.templateId, unit: f.unit.trim().toUpperCase(), location: f.location.trim() }); spNew.value = null; await load(); openSpot(rec.id);
    }

    /* ---------- 空白範本（PDF）工作流程：下載鎖定 → 上傳續填 → 現地手寫簽名 → 憑證加簽結案 ---------- */
    const pf = ref(null), pfPreview = ref(false), pfUrl = ref('');
    const wfUp = ref(null), wfCert = ref(null), wfVen = ref(null), wfUnf = ref(null);
    const pfTpl = computed(() => pf.value && tplOf(pf.value.rec.templateId));
    const pfRec = computed(() => pf.value && pf.value.rec);
    const pfSelf = computed(() => pf.value && pf.value.kind === 'self');
    const pfSt = computed(() => pfRec.value ? pfRec.value.wfStatus : '');
    const wfCls = st => st === '已結案' ? 'ok' : st === '未開始' ? '' : 'warn';
    const pfOperator = computed(() => pfSelf.value ? role.value === 'contractor' : isSup.value);
    const pfCanLock = computed(() => pfOperator.value && ['未開始', '待流轉'].includes(pfSt.value));
    const pfIsLocker = computed(() => pfSt.value === '鎖定中' && pfRec.value.lockedBy === me.value.name);
    const pfCanClose = computed(() => pfSelf.value ? (pfSt.value === '待流轉' && pfRec.value.lastUpdatedBy === me.value.name && role.value === 'contractor') : (pfSt.value === '待主任加簽' && isDirector.value));
    const pfCanVendor = computed(() => !pfSelf.value && pfSt.value === '待廠商簽名' && role.value === 'contractor');
    const pfCanUnfreeze = computed(() => pfSt.value === '已結案' && pfRec.value.lastUpdatedBy === me.value.name && !(pf.value.kind === 'spot' && pfRec.value.requestId));
    const pfHint = computed(() => {
      const st = pfSt.value, r = pfRec.value; if (!r) return '';
      if (st === '鎖定中') return pfIsLocker.value ? '您已鎖定本表。請離線填寫並簽名後，按「上傳並簽名」；不需要時可「取消鎖定」。' : `本表由「${r.lockedBy}」鎖定中，僅鎖定人可上傳或取消。`;
      if (st === '待流轉') return pfSelf.value ? (pfCanClose.value ? '已上傳並簽名，請辦理憑證加簽結案。' : `待最後上傳人「${r.lastUpdatedBy}」憑證加簽結案；亦可由他人下載續填。`) : '已轉下一位局內人員，可下載並鎖定後續填。';
      if (st === '待廠商簽名') return pfCanVendor.value ? '請下載最新版本，由施工廠商簽名後上傳。' : '待施工廠商簽名後上傳。';
      if (st === '待主任加簽') return isDirector.value ? '請以憑證辦理加簽及結案。' : '待工務所主任以憑證加簽結案。';
      if (st === '已結案') return '本表已結案並鎖定。';
      return pfOperator.value ? '尚未開始。請下載空白範本並鎖定後，離線填寫。' : (pfSelf.value ? '自主檢查表由廠商填寫；目前身分僅供檢視。' : '抽查紀錄由捷運局工務所同仁填寫；目前身分僅供檢視。');
    });
    function openPdf(kind, rec) { pf.value = { kind, rec: reactive(Q.clone(rec)) }; pfPreview.value = false; view.value = 'pdf'; window.scrollTo(0, 0); }
    watch([pfPreview, pfTpl], () => { if (pfUrl.value) URL.revokeObjectURL(pfUrl.value); pfUrl.value = pfPreview.value && pfTpl.value && pfTpl.value.pdf ? Q.pdfBlobUrl(pfTpl.value.pdf.data) : ''; });
    const pfStore = () => pf.value.kind === 'self' ? 'selfChecks' : 'spotChecks';
    async function pfRefresh() { const rec = await Q.get(pfStore(), pf.value.rec.id); pf.value.rec = reactive(Q.clone(rec)); await load(); }
    function pfDownloadBlank() { const f = pfTpl.value && pfTpl.value.pdf; if (!f) return toast('此範本尚未上傳空白 PDF，請至後台上傳', true); Q.downloadPdf(f); }
    function pfDownloadCur() { Q.downloadPdf(pfRec.value.pdfFile); }
    async function pfRun(fn, okMsg) { try { await fn(); await pfRefresh(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message, true); } }
    async function pfLock() {
      await pfRun(async () => { await Q.wfLock(pf.value.kind, pfRec.value.id, me.value.name); }, null);
      const f = pfRec.value.version > 0 ? pfRec.value.pdfFile : (pfTpl.value && pfTpl.value.pdf); if (f && pfIsLocker.value) { Q.downloadPdf(f); toast(pfRec.value.version > 0 ? '已下載最新版本並鎖定，請續填後上傳' : '已下載空白範本並鎖定，請離線填寫'); }
    }
    const pfCancel = () => pfRun(() => Q.wfCancel(pf.value.kind, pfRec.value.id, me.value.name), '已取消鎖定，釋放表單控制權');
    // 上傳並簽名（含現地手寫簽名）
    async function openWfUp() { wfUp.value = { file: null, next: 'vendor', result: pfRec.value.pdfResult || null }; drawn.value = false; await nextTick(); initCanvas(); }
    async function readPdfFile(e) {
      const file = e.target.files[0]; e.target.value = ''; if (!file) return null;
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('請選擇 PDF 檔案', true); return null; }
      if (file.size > 10 * 1048576) { toast('PDF 檔案過大（上限 10 MB）', true); return null; }
      return { name: file.name, size: file.size, data: await Q.fileToDataUrl(file), at: Date.now() };
    }
    async function onWfUpFile(e) { const f = await readPdfFile(e); if (f) wfUp.value.file = f; }
    async function submitWfUp() {
      const u = wfUp.value; if (!u.file) return toast('請上傳填寫後的 PDF 成果檔', true);
      if (!pfSelf.value && !u.result) return toast('請選擇抽查判定結果', true); if (!drawn.value) return toast('請於畫布完成手寫簽名', true);
      const sig = canvasEl.value.toDataURL('image/png'); const args = { file: u.file, sig, next: u.next, result: u.result };
      await pfRun(() => Q.wfUpload(pf.value.kind, pfRec.value.id, me.value.name, args), pfSelf.value ? '成果上傳與現地手寫簽名完成，待憑證加簽結案' : { relay: '已轉下一位局內人員續填', vendor: '已轉施工廠商簽名', supervisor: '已轉工務所主任加簽結案' }[u.next]); wfUp.value = null;
    }
    // 廠商簽名後上傳（抽查表）
    function openWfVen() { wfVen.value = { file: null }; }
    async function onWfVenFile(e) { const f = await readPdfFile(e); if (f) wfVen.value.file = f; }
    async function submitWfVen() { if (!wfVen.value.file) return toast('請上傳簽名後的 PDF', true); await pfRun(() => Q.wfVendorSign(pfRec.value.id, me.value.name, wfVen.value.file), '簽名後 PDF 已上傳，已轉工務所主任加簽結案'); wfVen.value = null; }
    // 憑證加簽結案（模擬讀卡／行動憑證簽章）
    function openWfCert() { wfCert.value = { method: 'ic-card', running: false, pct: 0 }; }
    function submitWfCert() {
      const c = wfCert.value; c.running = true; c.pct = 0;
      const t = setInterval(async () => {
        c.pct += 50; if (c.pct < 100) return; clearInterval(t);
        await pfRun(() => Q.wfClose(pf.value.kind, pfRec.value.id, me.value.name, c.method), pfSelf.value ? '憑證加簽與結案作業完成！' : '主任加簽與結案作業完成！'); wfCert.value = null;
      }, 500);
    }
    function openWfUnf() { wfUnf.value = { reason: '' }; }
    async function submitWfUnf() { if (!wfUnf.value.reason.trim()) return toast('請填寫解除結案原因', true); await pfRun(() => Q.wfUnfreeze(pf.value.kind, pfRec.value.id, me.value.name, wfUnf.value.reason.trim()), '已解除結案'); wfUnf.value = null; }
    function dlLog(l) { Q.downloadPdf(l.file); }
    function leavePdf() { const k = pf.value.kind; pf.value = null; view.value = k === 'self' ? 'checks' : 'spots'; load(); }

    /* ---------- 簽認 ---------- */
    const signCtx = ref(null), signHash = ref(''), signAgree = ref(false), canvasEl = ref(null);
    let drawn = ref(false), drawing = false, lastPt = null;
    const signers = computed(() => !signCtx.value ? [] : signCtx.value.kind === 'self'
      ? [{ key: 'site', title: '現場工程師（檢查人員）', org: '示範品管・大陸工程股份有限公司', name: '示範品管' }, { key: 'rep', title: '工地授權代表或其授權主管', org: '示範工地主任・大陸工程股份有限公司', name: '示範工地主任' }]
      : [{ key: 'insp', title: '監造工務所（抽查人員）', org: '示範工務所同仁・捷運局工務所', name: '示範工務所同仁' }, { key: 'att', title: '施工廠商隨同人員', org: '示範品管・大陸工程股份有限公司', name: '示範品管' }]);
    const signRec = computed(() => signCtx.value && (signCtx.value.kind === 'self' ? signCtx.value.rec : signCtx.value.rec));
    const signIdx = ref(0);
    const curSigner = computed(() => signers.value[signIdx.value]);
    const signSummary = computed(() => {
      const c = signCtx.value; if (!c) return [];
      if (c.kind === 'self') return [['檢查結果', `○ ${summary.value.ok}　╳ ${summary.value.ng}　╱ ${summary.value.na}`], ['檢驗停留點', `${holdItems.value.filter(i => hstate(i) === 'passed').length} 項已放行`], ['現場照片', summary.value.photos + ' 張'], ['自動附件', attachCodes.value.map(x => '表' + x).join('、') || '—'], ['內容雜湊', (signHash.value || '').slice(0, 14) + '…']];
      return [['抽查結果', `○ ${spSummary.value.ok}　╳ ${spSummary.value.ng}　╱ ${spSummary.value.na}`], ['抽查時機', c.rec.kind === 'hold' ? '檢驗停留點：★' + c.rec.title : '隨機抽查'], ['現場照片', spSummary.value.photos + ' 張'], ['自動附件', '廠商自主檢查表 ' + (c.rec.scId || '—')], ['內容雜湊', (signHash.value || '').slice(0, 14) + '…']];
    });
    async function openSign(kind, id) {
      const rec = kind === 'self' ? cur.value : sp.value;
      signCtx.value = { kind, id, rec }; signIdx.value = rec.signatures && rec.signatures[signers.value[0].key] ? 1 : 0; signAgree.value = false; drawn.value = false;
      signHash.value = await Q.hashOf(kind === 'self' ? { a: rec.answers, l: rec.linked, h: rec.hold } : { a: rec.answers, c: rec.calc });
      view.value = 'sign'; await nextTick(); initCanvas();
    }
    function initCanvas() {
      const c = canvasEl.value; if (!c) return; const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; c.width = r.width * dpr; c.height = r.height * dpr;
      const g = c.getContext('2d'); g.scale(dpr, dpr); g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111827'; drawn.value = false;
    }
    function pt(e) { const r = canvasEl.value.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function sDown(e) { e.preventDefault(); drawing = true; lastPt = pt(e); canvasEl.value.setPointerCapture && canvasEl.value.setPointerCapture(e.pointerId); }
    function sMove(e) { if (!drawing) return; e.preventDefault(); const p = pt(e), g = canvasEl.value.getContext('2d'); g.beginPath(); g.moveTo(lastPt.x, lastPt.y); g.lineTo(p.x, p.y); g.stroke(); lastPt = p; drawn.value = true; }
    function sUp() { drawing = false; }
    function clearSign() { const c = canvasEl.value; c.getContext('2d').clearRect(0, 0, c.width, c.height); drawn.value = false; }
    async function applySaved() {
      const m = await Q.get('meta', 'sig-' + curSigner.value.key); if (!m) return toast('尚無已存簽名，請先簽名並勾選「儲存簽名」', true);
      const img = new Image(); img.onload = () => { const c = canvasEl.value, r = c.getBoundingClientRect(); clearSign(); c.getContext('2d').drawImage(img, 0, 0, r.width, r.height); drawn.value = true; }; img.src = m.img;
    }
    const saveSig = ref(true);
    async function confirmSign() {
      if (!drawn.value) return toast('請先在框內簽名', true); if (!signAgree.value) return toast('請勾選確認聲明', true);
      const c = signCtx.value, s = curSigner.value, img = canvasEl.value.toDataURL('image/png');
      c.rec.signatures = c.rec.signatures || {}; c.rec.signatures[s.key] = { img, at: Date.now(), name: s.name };
      if (saveSig.value) await Q.put('meta', { id: 'sig-' + s.key, img });
      if (c.kind === 'self') await Q.put('selfChecks', Q.clone(c.rec)); else await Q.put('spotChecks', Q.clone(c.rec));
      if (signIdx.value < signers.value.length - 1) { signIdx.value++; signAgree.value = false; await nextTick(); initCanvas(); toast(`${s.title} 已簽認，請 ${signers.value[signIdx.value].title} 簽名`); return; }
      if (c.kind === 'self') { await Q.finalizeSelf(c.id); toast('自主檢查表已簽認完成並鎖定'); cur.value = null; view.value = 'checks'; }
      else { await Q.finalizeSpot(c.id); const ng = Object.values(c.rec.answers).some(a => a.judge === 'ng'); toast(ng ? '抽查完成：有缺失，已建立缺失追蹤' : (c.rec.requestId ? '抽查完成：合格放行，後續項目已解鎖' : '抽查紀錄已簽認完成')); sp.value = null; view.value = 'spots'; }
      signCtx.value = null; await load();
    }
    function cancelSign() { const c = signCtx.value; signCtx.value = null; view.value = c.kind === 'self' ? 'form' : 'spot'; }

    /* ---------- 缺失、參考文件、我的 ---------- */
    const defCls = x => x.due < now.value ? 'ng' : x.status === 'review' ? 'warn' : 'blue';
    const defText = x => x.status === 'review' ? '待複查' : x.due < now.value ? `逾期 ${Math.ceil((now.value - x.due) / Q.D)} 天` : `期限 ${Q.fmtD(x.due)}`;
    async function defAct(x) { await Q.setDefectStatus(x.id, isSup.value ? 'closed' : 'review'); await load(); toast(isSup.value ? '複查合格，缺失已結案' : '已回報改善完成，待監造複查'); }
    async function resetDemo() { if (!confirm('將清除所有資料並還原示範資料，確定？')) return; await Q.seed(true); cur.value = null; sp.value = null; view.value = 'todo'; await load(); toast('已還原示範資料'); }
    async function clearSigs() { for (const k of ['site', 'rep', 'insp', 'att']) await Q.del('meta', 'sig-' + k); toast('已清除已存簽名'); }
    const navItems = computed(() => [['todo', '待辦', todoCount.value], ['checks', '自主檢查', 0], ['spots', '抽查紀錄', 0], ['holds', '停留點', 0], ['docs', '參考文件', 0], ['me', '我的', 0]]);
    function nav(v) { if (view.value === 'form') flush(); if (view.value === 'spot') spFlush(); view.value = v; if (v !== 'form') cur.value = null; sp.value = null; pf.value = null; selReqId.value = null; window.scrollTo(0, 0); }
    const navActive = computed(() => ({ pdf: pf.value && pf.value.kind === 'spot' ? 'spots' : 'checks', form: 'checks', spot: 'spots', sign: signCtx.value && signCtx.value.kind === 'self' ? 'checks' : 'spots' })[view.value] || view.value);
    const printForm = () => window.print();

    watch(wide, () => { if (view.value === 'sign') nextTick(initCanvas); });
    onMounted(async () => {
      await Q.ready; await load();
      const q = new URLSearchParams(location.search); if (q.get('role')) role.value = q.get('role');
      Q.onChange(async () => { await load(); if (cur.value && cur.value.status !== 'signed') { const sc = await Q.get('selfChecks', cur.value.id); if (sc) cur.value.hold = sc.hold; } });
      setInterval(async () => { await Q.tickOverdue(); await load(); }, 30000);
      window.addEventListener('beforeunload', () => { if (saveTimer) flush(); });
    });

    return {
      Q, d, loaded, now, view, todoTab, tenderSel, role, isSup, me, wide, toastMsg, toastNg, toast, tplOf, rel, hh, todayLabel, reqCls,
      todoReqs, lockedCards, draftSpots, openDefects, todoCount, holdFilter, holdsList, selReqId, selReq, sched, selectReq, reqChips, reqPhotos, lockedAfter, doSchedule, doReject, doStart,
      pf, pfPreview, pfUrl, pfTpl, pfRec, pfSelf, pfSt, wfCls, pfCanLock, pfIsLocker, pfCanClose, pfCanVendor, pfCanUnfreeze, pfHint, pfDownloadBlank, pfDownloadCur, pfLock, pfCancel, wfUp, wfCert, wfVen, wfUnf, openWfUp, onWfUpFile, submitWfUp, openWfVen, onWfVenFile, submitWfVen, openWfCert, submitWfCert, openWfUnf, submitWfUnf, dlLog, leavePdf, isDirector, scList, scProgress, newForm, qrForm, tenderOpts, swOpts, tplOpts, cascade, openNew, createSc, scanQr,
      cur, curTpl, stageTab, itemNo, saveMsg, docShow, linkShow, applyForm, readonly, stageList, curItem, shownItems, judged, total, stageStat, stageDone, ans, ensure, lockOf, hstate, hreq, itemEditable, sugg, itemIcon,
      flush, queueSave, openSc, gotoItem, setStage, step, setJudge, addPhoto, addDemoPhoto, delPhoto, useSuggest, markLinked, confirmQr, canApply, openApply, applyShort, applyHours, submitApply, holdText,
      summary, holdItems, attachCodes, canSubmit, goSign, finishStage, stageTabs, stageNext, leaveForm,
      sp, spStage, spItemNo, spSaveMsg, spNew, spTpl, spReq, spSc, spEditable, spStageList, spCurItem, spShown, spA, spJudged, spTotal, spSummary, spStageStat, spSelfVals, spSugg, spArea, spLocked, spList, spProgress, spSave, spFlush, openSpot, spGoto, spSetStage, spJudge, spUseSuggest, spPhoto, spDemoPhoto, spDelPhoto, spGoSign, leaveSpot, openSpotNew, createSpot,
      signCtx, signHash, signAgree, canvasEl, drawn, signers, signIdx, curSigner, signSummary, sDown, sMove, sUp, clearSign, applySaved, saveSig, confirmSign, cancelSign,
      defCls, defText, defAct, resetDemo, clearSigs, navItems, nav, navActive, printForm
    };
  }
}).mount('#app');
