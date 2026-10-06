/* 現場作業頁 (RWD：平板／手機) - Vue 3 全域版 + IndexedDB */
const { createApp, reactive, ref, computed, watch, onMounted, nextTick } = Vue;

createApp({
  setup() {
    const Q = QMS;
    const d = reactive({ tenders: [], subworks: [], templates: [], selfChecks: [], requests: [], spotChecks: [], defects: [], docs: [], params: {} });
    const loaded = ref(false), now = ref(Date.now());
    const view = ref('todo'), todoTab = ref('hold'), tenderSel = ref('all');
    const role = ref((() => { try { return localStorage.getItem('qms-role') || 'contractor'; } catch (e) { return 'contractor'; } })());
    const isSup = computed(() => role.value === 'supervisor');
    watch(role, v => { try { localStorage.setItem('qms-role', v); } catch (e) { /* ignore */ } });
    const me = computed(() => isSup.value ? { name: '示範監造', org: '監造工務所', title: '監造現場工程師' } : { name: '示範品管', org: '大陸工程股份有限公司', title: '廠商品管人員' });
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
    const scProgress = sc => { const t = tplOf(sc.templateId); return { n: Object.values(sc.answers).filter(a => a.judge).length, total: t ? t.items.length : 0 }; };
    const newForm = ref(null), qrForm = ref(null);
    const selfTpls = computed(() => d.templates.filter(t => t.kind === 'self' && t.status === 'published').sort((a, b) => b.items.length - a.items.length));
    function openNew(unit) { newForm.value = { templateId: (selfTpls.value[0] || {}).id, unit: unit || '', location: '' }; }
    async function createSc() {
      const f = newForm.value; if (!f.unit.trim()) return toast('請輸入單元編號', true); if (!f.templateId) return toast('請選擇表單', true);
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
      const sc = await Q.get('selfChecks', id); cur.value = reactive(Q.clone(sc)); stageTab.value = 'pre'; saveMsg.value = '';
      const t0 = tplOf(sc.templateId); if (t0) t0.items.forEach(i => { if (!cur.value.answers[i.no]) cur.value.answers[i.no] = { judge: null, values: {}, photos: [], note: '' }; });
      const t = tplOf(sc.templateId); if (t) { const first = t.items.find(i => !(sc.answers[i.no] || {}).judge) || t.items[0]; itemNo.value = first.no; stageTab.value = first.stage; }
      view.value = 'form'; window.scrollTo(0, 0);
    }
    function gotoItem(it) { itemNo.value = it.no; stageTab.value = it.stage; }
    function setStage(st) { stageTab.value = st; const l = Q.stageItems(curTpl.value, st); const f = l.find(i => !ans(i.no).judge) || l[0]; if (f) itemNo.value = f.no; }
    function step(dir) { const its = curTpl.value.items, i = its.findIndex(x => x.no === itemNo.value) + dir; if (i >= 0 && i < its.length) gotoItem(its[i]); }
    function setJudge(it, j) {
      if (readonly.value) return toast(isSup.value ? '監造身分僅能檢視自主檢查表' : '表單已簽認，不可修改', true);
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

    /* ---------- 抽查紀錄 ---------- */
    const sp = ref(null);
    const spReq = computed(() => sp.value && d.requests.find(r => r.id === sp.value.requestId));
    const spSc = computed(() => sp.value && d.selfChecks.find(s => s.id === sp.value.scId));
    const spSelfItem = computed(() => { const t = spSc.value && tplOf(spSc.value.templateId); return t && t.items.find(i => i.no === sp.value.itemNo); });
    const spFields = computed(() => {
      const tp = tplOf(sp.value.templateId); const si = tp && tp.items.find(i => i.srcNo === sp.value.itemNo && i.fields.length);
      const f = (si && si.fields) || (spSelfItem.value && spSelfItem.value.fields) || []; return f.length ? f : [Q.F('v', '實測值', '', null, null)];
    });
    const selfVal = f => { const a = spSc.value && spSc.value.answers[sp.value.itemNo]; const v = a && a.values && a.values[f.key]; return v === undefined || v === '' ? null : v; };
    const spSugg = computed(() => sp.value ? Q.suggest({ fields: spFields.value }, sp.value.measures) : null);
    const spArea = computed(() => { const l = Number(sp.value && sp.value.calc.length), dp = Number(sp.value && sp.value.calc.depth); return l && dp ? (l * dp).toFixed(2) : ''; });
    const spLocked = computed(() => spReq.value ? lockedAfter(spReq.value) : []);
    const spEditable = computed(() => sp.value && sp.value.status !== 'signed' && isSup.value);
    let spTimer = null;
    function spSave() { clearTimeout(spTimer); spTimer = setTimeout(() => Q.put('spotChecks', Q.clone(sp.value)), 400); }
    async function openSpot(id) { sp.value = reactive(Q.clone(await Q.get('spotChecks', id))); view.value = 'spot'; window.scrollTo(0, 0); }
    function spJudge(j) { if (!spEditable.value) return toast(isSup.value ? '表單已簽認' : '抽查紀錄由監造人員填寫（請於「我的」切換為監造）', true); sp.value.judge = sp.value.judge === j ? null : j; spSave(); }
    function spPhoto() { if (!spEditable.value) return; pickPhoto(`${sp.value.tenderCode}・${sp.value.location}・★${sp.value.title}`, u => { sp.value.photos.push(u); spSave(); }); }
    function spDemoPhoto() { if (!spEditable.value) return; demoPhoto(`${sp.value.tenderCode}・${sp.value.location}・★${sp.value.title}`, u => { sp.value.photos.push(u); spSave(); }); }
    async function spGoSign() { if (!sp.value.judge) return toast('請先判定結果', true); clearTimeout(spTimer); await Q.put('spotChecks', Q.clone(sp.value)); openSign('spot', sp.value.id); }
    async function leaveSpot() { clearTimeout(spTimer); if (sp.value && sp.value.status !== 'signed') await Q.put('spotChecks', Q.clone(sp.value)); sp.value = null; view.value = 'todo'; await load(); }

    /* ---------- 簽認 ---------- */
    const signCtx = ref(null), signHash = ref(''), signAgree = ref(false), canvasEl = ref(null);
    let drawn = ref(false), drawing = false, lastPt = null;
    const signers = computed(() => !signCtx.value ? [] : signCtx.value.kind === 'self'
      ? [{ key: 'site', title: '現場工程師（檢查人員）', org: '示範品管・大陸工程股份有限公司', name: '示範品管' }, { key: 'rep', title: '工地授權代表或其授權主管', org: '示範工地主任・大陸工程股份有限公司', name: '示範工地主任' }]
      : [{ key: 'insp', title: '監造工務所（抽查人員）', org: '示範監造・監造工務所', name: '示範監造' }, { key: 'att', title: '施工廠商隨同人員', org: '示範品管・大陸工程股份有限公司', name: '示範品管' }]);
    const signRec = computed(() => signCtx.value && (signCtx.value.kind === 'self' ? signCtx.value.rec : signCtx.value.rec));
    const signIdx = ref(0);
    const curSigner = computed(() => signers.value[signIdx.value]);
    const signSummary = computed(() => {
      const c = signCtx.value; if (!c) return [];
      if (c.kind === 'self') return [['檢查結果', `○ ${summary.value.ok}　╳ ${summary.value.ng}　╱ ${summary.value.na}`], ['檢驗停留點', `${holdItems.value.filter(i => hstate(i) === 'passed').length} 項已放行`], ['現場照片', summary.value.photos + ' 張'], ['自動附件', attachCodes.value.map(x => '表' + x).join('、') || '—'], ['內容雜湊', (signHash.value || '').slice(0, 14) + '…']];
      return [['判定', Q.JUDGE[c.rec.judge]], ['現場照片', c.rec.photos.length + ' 張'], ['自動附件', '廠商自主檢查表 ' + (c.rec.scId || '—')], ['內容雜湊', (signHash.value || '').slice(0, 14) + '…']];
    });
    async function openSign(kind, id) {
      const rec = kind === 'self' ? cur.value : sp.value;
      signCtx.value = { kind, id, rec }; signIdx.value = rec.signatures && rec.signatures[signers.value[0].key] ? 1 : 0; signAgree.value = false; drawn.value = false;
      signHash.value = await Q.hashOf(kind === 'self' ? { a: rec.answers, l: rec.linked, h: rec.hold } : { m: rec.measures, j: rec.judge, c: rec.calc });
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
      else { await Q.finalizeSpot(c.id); toast(c.rec.judge === 'ng' ? '抽查完成：有缺失，已建立缺失追蹤' : '抽查完成：合格放行，後續項目已解鎖'); sp.value = null; view.value = 'todo'; }
      signCtx.value = null; await load();
    }
    function cancelSign() { const c = signCtx.value; signCtx.value = null; view.value = c.kind === 'self' ? 'form' : 'spot'; }

    /* ---------- 缺失、參考文件、我的 ---------- */
    const defCls = x => x.due < now.value ? 'ng' : x.status === 'review' ? 'warn' : 'blue';
    const defText = x => x.status === 'review' ? '待複查' : x.due < now.value ? `逾期 ${Math.ceil((now.value - x.due) / Q.D)} 天` : `期限 ${Q.fmtD(x.due)}`;
    async function defAct(x) { await Q.setDefectStatus(x.id, isSup.value ? 'closed' : 'review'); await load(); toast(isSup.value ? '複查合格，缺失已結案' : '已回報改善完成，待監造複查'); }
    async function resetDemo() { if (!confirm('將清除所有資料並還原示範資料，確定？')) return; await Q.seed(true); cur.value = null; sp.value = null; view.value = 'todo'; await load(); toast('已還原示範資料'); }
    async function clearSigs() { for (const k of ['site', 'rep', 'insp', 'att']) await Q.del('meta', 'sig-' + k); toast('已清除已存簽名'); }
    const navItems = computed(() => [['todo', '待辦', todoCount.value], ['checks', '自主檢查', 0], ['holds', '停留點', 0], ['docs', '參考文件', 0], ['me', '我的', 0]]);
    function nav(v) { if (view.value === 'form') flush(); view.value = v; if (v !== 'form') cur.value = null; sp.value = null; selReqId.value = null; window.scrollTo(0, 0); }
    const navActive = computed(() => ({ form: 'checks', spot: 'todo', sign: signCtx.value && signCtx.value.kind === 'self' ? 'checks' : 'todo' })[view.value] || view.value);
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
      scList, scProgress, newForm, qrForm, selfTpls, openNew, createSc, scanQr,
      cur, curTpl, stageTab, itemNo, saveMsg, docShow, linkShow, applyForm, readonly, stageList, curItem, shownItems, judged, total, stageStat, stageDone, ans, ensure, lockOf, hstate, hreq, itemEditable, sugg, itemIcon,
      flush, queueSave, openSc, gotoItem, setStage, step, setJudge, addPhoto, addDemoPhoto, delPhoto, useSuggest, markLinked, confirmQr, canApply, openApply, applyShort, applyHours, submitApply, holdText,
      summary, holdItems, attachCodes, canSubmit, goSign, finishStage, stageTabs, stageNext, leaveForm,
      sp, spReq, spSc, spSelfItem, spFields, selfVal, spSugg, spArea, spLocked, spEditable, spSave, openSpot, spJudge, spPhoto, spDemoPhoto, spGoSign, leaveSpot,
      signCtx, signHash, signAgree, canvasEl, drawn, signers, signIdx, curSigner, signSummary, sDown, sMove, sUp, clearSign, applySaved, saveSig, confirmSign, cancelSign,
      defCls, defText, defAct, resetDemo, clearSigs, navItems, nav, navActive, printForm
    };
  }
}).mount('#app');
