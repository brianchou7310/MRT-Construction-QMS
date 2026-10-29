/* 後台管理頁 (Vue 3 全域版 + IndexedDB) */
const { createApp, reactive, ref, computed, watch, onMounted, nextTick } = Vue;

createApp({
  setup() {
    const Q = QMS;
    const d = reactive({ tenders: [], subworks: [], templates: [], selfChecks: [], requests: [], spotChecks: [], defects: [], docs: [], users: [], params: {} });
    const now = ref(Date.now());
    const loaded = ref(false);
    // 後台身份：系統管理員（全部）或部門（2J／2B／2F），記在 localStorage
    const dept = ref((() => { try { return localStorage.getItem('qms3-admin-dept') || ''; } catch (e) { return ''; } })());
    const allTenders = ref([]);
    const deptName = computed(() => (Q.DEPTS.find(x => x.id === dept.value) || {}).name || '系統管理員');
    async function setDept(v) { dept.value = v; try { localStorage.setItem('qms3-admin-dept', v); } catch (e) { /* ignore */ } await load(); toast(`已切換身份：${deptName.value}${v ? `（${v}）` : ''}`); }
    const fixPage = p => (p === 'import' ? 'templates' : (!p || p === 'dashboard') ? 'holds' : p); // 範本匯入頁已移除；查驗總覽已移除，首頁為停留點會驗管理
    const page = ref(fixPage((location.hash || '#holds').slice(1)));
    const menuOpen = ref(false);
    const toastMsg = ref(''), toastNg = ref(false);
    function toast(m, ng) { toastMsg.value = m; toastNg.value = !!ng; setTimeout(() => { toastMsg.value = ''; }, 2600); }

    async function load() {
      const [tenders, subworks, templates, selfChecks, requests, spotChecks, defects, docs, users, params] = await Promise.all(
        ['tenders', 'subworks', 'templates', 'selfChecks', 'requests', 'spotChecks', 'defects', 'docs', 'users'].map(s => Q.all(s)).concat([Q.getParams()]));
      // 依後台身份（部門）只顯示該部門負責的標案及其資料；allTenders 保留全部，供「新增標案」判斷是否已加入
      allTenders.value = tenders;
      const vis = new Set(tenders.filter(t => Q.tenderInDept(t, dept.value)).map(t => t.id)), inT = x => vis.has(x.tenderId), keys = new Set(tenders.filter(t => vis.has(t.id)).map(Q.projKey));
      Object.assign(d, { tenders: Q.sortTenders(tenders.filter(t => vis.has(t.id))), subworks: subworks.filter(inT), templates: templates.filter(inT), selfChecks: selfChecks.filter(inT), requests: requests.filter(inT), spotChecks: spotChecks.filter(inT), defects: defects.filter(inT), docs: docs.filter(x => !dept.value || keys.has(x.projKey)), users, params });
      if (d.tenders.length && !d.tenders.some(t => t.id === selTenderId.value)) selTenderId.value = d.tenders[0].id;
      if (tenderFilter.value !== 'all' && !d.tenders.some(t => t.id === tenderFilter.value)) tenderFilter.value = 'all';
      now.value = Date.now(); loaded.value = true;
    }
    function go(p) { page.value = p; location.hash = p; menuOpen.value = false; window.scrollTo(0, 0); }
    window.addEventListener('hashchange', () => { page.value = fixPage((location.hash || '#holds').slice(1)); });

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
    const spotNg = p => p.fillMode === 'pdf' ? false : Object.values(p.answers || {}).some(a => a.judge === 'ng');
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
    const treeOpen = reactive({ T671: true }), grpOpen = reactive({}), swPick = ref(null);
    // 標案樹：區段標 → 子標；單一標另成一組
    const treeGroups = computed(() => { const m = new Map(); d.tenders.slice().forEach(t => { const k = t.parentCode || ''; if (!m.has(k)) m.set(k, { key: k, code: k, name: t.parentName || '', items: [] }); m.get(k).items.push(t); });
      return [...m.values()].sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || a.key.localeCompare(b.key)); });
    const grpIsOpen = g => grpOpen[g.key || '_'] !== false;
    // 標案架構：同一區段標內的子標可拖曳調整順序（排序同步套用到表單範本、現場新增表單等下拉選單）
    const tDragId = ref(null), tDragOver = ref(null);
    function tDragStart(e, t) { tDragId.value = t.id; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.id); } catch (x) { /* ignore */ } }
    function tDragEnd() { tDragId.value = null; tDragOver.value = null; }
    async function tDrop(target) {
      const id = tDragId.value; tDragEnd(); if (!id || id === target.id) return;
      const mover = d.tenders.find(x => x.id === id); if (!mover) return;
      if ((mover.parentCode || '') !== (target.parentCode || '')) return toast('只能在同一個區段標內調整子標順序', true);
      const list = d.tenders.filter(x => (x.parentCode || '') === (target.parentCode || '')), from = list.findIndex(x => x.id === id), to = list.findIndex(x => x.id === target.id);
      const [m] = list.splice(from, 1); list.splice(to, 0, m);
      for (let i = 0; i < list.length; i++) { const t = Q.clone(list[i]); t.order = i; await Q.put('tenders', t); }
      await load(); toast('已調整子標順序，表單範本等下拉選單同步套用');
    }
    function treeAll(open) { treeGroups.value.forEach(g => { grpOpen[g.key || '_'] = open; }); d.tenders.forEach(t => { treeOpen[t.id] = open; }); }
    function pickTender(t) { if (selTenderId.value === t.id && !swPick.value) { treeOpen[t.id] = !treeOpen[t.id]; return; } selTenderId.value = t.id; swPick.value = null; treeOpen[t.id] = true; }
    function pickSw(s) { selTenderId.value = s.tenderId; swSearch.value = ''; swStatus.value = ''; swPick.value = s.id; swPage.value = 1; }
    const swAll = computed(() => d.subworks.filter(s => s.tenderId === selTenderId.value).sort((a, b) => a.order - b.order).filter(s => (!swPick.value || s.id === swPick.value) && (!swSearch.value || s.name.includes(swSearch.value)) && (!swStatus.value || s.status === swStatus.value)));
    const swPaged = computed(() => swAll.value.slice((swPage.value - 1) * 15, swPage.value * 15));
    const swPages = computed(() => Math.max(1, Math.ceil(swAll.value.length / 15)));
    watch([swSearch, swStatus, selTenderId], () => { swPage.value = 1; });
    watch(selTenderId, id => { if (swPick.value && (d.subworks.find(s => s.id === swPick.value) || {}).tenderId !== id) swPick.value = null; });
    const swTplText = (s, kind) => { const l = d.templates.filter(t => t.subworkId === s.id && t.kind === kind && t.status === 'published'); const p = l.filter(t => t.fillMode === 'pdf').length; return l.length ? l.length + ' 張' + (p ? `（PDF ${p}）` : '') : '未設定'; };
    const swHold = s => d.templates.filter(t => t.subworkId === s.id && t.kind === 'self' && t.status === 'published').reduce((n, t) => n + (t.fillMode === 'pdf' ? 0 : t.items.filter(i => i.hold).length), 0);
    const swForm = ref(null);
    async function saveSw() {
      const s = swForm.value; if (!s.name.trim()) return toast('請輸入分項工程名稱', true);
      if (!s.id) { s.id = Q.uid('S'); s.order = d.subworks.length; s.tenderId = selTenderId.value; }
      s.qty = Number(s.qty) || 0; await Q.put('subworks', s); swForm.value = null; await load(); toast('分項工程已儲存');
    }
    /* ---------- 分項工程匯入（Excel／CSV） ---------- */
    const SW_HEAD = ['項次', '分項工程', '數量', '單位', '狀態'], SW_ST = ['施工中', '未開始', '已完成'];
    const swImp = ref(null);
    function openSwImp() { if (!selTenderId.value) return toast('請先選擇標案', true); swImp.value = { fileName: '', rows: [], err: '', mode: 'upsert' }; }
    // 匯入樣本：標案尚無分項工程 → 空白樣本（標題＋一列範例）；已有分項工程 → 帶出現有全部分項工程，可直接修改後匯入
    function swSample() {
      const cur = d.subworks.filter(s => s.tenderId === selTenderId.value).sort((a, b) => a.order - b.order).map(s => [s.no, s.name, s.qty, s.unit, s.status]);
      return cur.length ? [SW_HEAD].concat(cur) : [SW_HEAD, ['99', '（範例）新增分項工程名稱', 100, 'M', '未開始']];
    }
    function downloadSwSample() {
      const ws = XLSX.utils.aoa_to_sheet(swSample()); ws['!cols'] = [8, 36, 10, 8, 10].map(w => ({ wch: w }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '分項工程'); XLSX.writeFile(wb, `${selTender.value.code || '標案'}_分項工程匯入樣本.xlsx`);
    }
    function parseSwRows(rows) {
      const m = swImp.value; m.rows = []; m.err = '';
      if (!rows.length) { m.err = '檔案沒有資料'; return; }
      const head = rows[0].map(h => String(h).trim()), ix = n => head.indexOf(n);
      const miss = ['分項工程'].filter(n => ix(n) < 0); if (miss.length) { m.err = '找不到必要欄位：' + miss.join('、') + '（第一列須為欄位標題：' + SW_HEAD.join('、') + '）'; return; }
      const cell = (r, n) => ix(n) < 0 ? '' : String(r[ix(n)] == null ? '' : r[ix(n)]).trim();
      const exist = d.subworks.filter(s => s.tenderId === selTenderId.value), seen = {};
      rows.slice(1).forEach((r, k) => {
        if (!r.some(x => String(x).trim())) return;
        const errs = [], name = cell(r, '分項工程'), no = cell(r, '項次'), qtyT = cell(r, '數量').replace(/,/g, ''), unit = cell(r, '單位') || '式', st = cell(r, '狀態') || '施工中';
        if (!name) errs.push('分項工程名稱不可空白');
        if (qtyT && isNaN(Number(qtyT))) errs.push('數量「' + qtyT + '」不是數字');
        if (!SW_ST.includes(st)) errs.push('狀態「' + st + '」須為 施工中／未開始／已完成');
        if (name && seen[name]) errs.push('與第 ' + seen[name] + ' 列名稱重複'); else if (name) seen[name] = k + 2;
        const hit = exist.find(s => s.name === name) || (no && exist.find(s => s.no === no));
        m.rows.push({ line: k + 2, no, name, qty: qtyT && !isNaN(Number(qtyT)) ? Number(qtyT) : 0, qtyText: qtyT, unit, status: st, hit: hit ? hit.id : '', errs });
      });
      if (!m.rows.length) m.err = '沒有資料列，請確認第一列為欄位標題';
    }
    function onSwFile(e) {
      const f = e.target.files[0]; if (!f) return; const m = swImp.value; m.fileName = f.name; const rd = new FileReader();
      if (/\.xlsx?$/i.test(f.name)) {
        rd.onload = () => { try { const wb = XLSX.read(rd.result, { type: 'array' }); parseSwRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' })); } catch (ex) { m.err = '無法讀取 Excel：' + ex.message; } };
        rd.readAsArrayBuffer(f);
      } else { rd.onload = () => parseSwRows(parseCsv(String(rd.result).replace(/^\ufeff/, ''))); rd.readAsText(f, 'utf-8'); }
    }
    const swImpOk = computed(() => swImp.value ? swImp.value.rows.filter(r => !r.errs.length) : []);
    const swImpBad = computed(() => swImp.value ? swImp.value.rows.length - swImpOk.value.length : 0);
    async function doSwImp() {
      const m = swImp.value, ok = swImpOk.value; if (!ok.length) return toast('沒有可匯入的列', true);
      let order = Math.max(-1, ...d.subworks.filter(s => s.tenderId === selTenderId.value).map(s => s.order || 0)) + 1, add = 0, upd = 0;
      for (const r of ok) {
        const old = m.mode === 'upsert' && r.hit ? d.subworks.find(s => s.id === r.hit) : null;
        if (old) { await Q.put('subworks', Object.assign(Q.clone(old), { no: r.no || old.no, name: r.name, qty: r.qty, unit: r.unit, status: r.status })); upd++; }
        else { await Q.put('subworks', { id: Q.uid('S'), tenderId: selTenderId.value, no: r.no || String(order + 1), name: r.name, qty: r.qty, unit: r.unit, status: r.status, order: order++ }); add++; }
      }
      swImp.value = null; await load(); treeOpen[selTenderId.value] = true;
      toast(`分項工程匯入完成：新增 ${add} 項、更新 ${upd} 項${swImpBad.value ? `（略過錯誤列）` : ''}`);
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
    // 移除標案：標案底下已有填寫紀錄（自主檢查、抽查、會驗、缺失）者不可刪除；沒有紀錄則連同分項工程、表單範本一併移除
    function tenderRefs(t) { const n = (arr) => arr.filter(x => x.tenderId === t.id).length; return [['自主檢查紀錄', n(d.selfChecks)], ['抽查紀錄', n(d.spotChecks)], ['會驗申請', n(d.requests)], ['缺失追蹤', n(d.defects)]].filter(r => r[1]); }
    async function delTender(t) {
      const refs = tenderRefs(t); if (refs.length) return toast(`「${Q.tLabel(t)}」已有 ${refs.map(r => r[0] + ' ' + r[1] + ' 筆').join('、')}，不可移除`, true);
      const sws = d.subworks.filter(s => s.tenderId === t.id), tps = d.templates.filter(x => x.tenderId === t.id);
      if (!confirm(`移除標案「${t.code} ${Q.tLabel(t)}」？\n將一併移除 ${sws.length} 個分項工程、${tps.length} 張表單範本，此動作無法復原。（可再從「＋ 新增標案」重新加入）`)) return;
      for (const x of tps) await Q.del('templates', x.id); for (const x of sws) await Q.del('subworks', x.id); await Q.del('tenders', t.id);
      swPick.value = null; await load(); toast('已移除標案');
    }
    /* ---------- 新增標案：由標案管理系統（ProjBase）挑選 ----------
       依登入部門（WORK_SECTION_ID）列出：該部門的區段標＋底下全部子標（子標不比對部門）、該部門的單一標 */
    const pick = ref(null);
    function newTender() {
      if (!window.QMS_PROJBASE) return toast('找不到標案管理系統資料', true);
      pick.value = { q: '', step: 'B', sel: {}, open: {} };
    }
    const pickData = computed(() => {
      if (!pick.value) return { groups: [], singles: [], total: 0 };
      const P = window.QMS_PROJBASE, dp = dept.value, f = pick.value, q = f.q.trim().toLowerCase(), have = new Set(allTenders.value.map(t => t.code));
      const ok = r => (!f.step || r.STEP_TYPE === f.step) && (!q || (r.PROJ_ID + ' ' + r.PROJ_NAME_C + ' ' + (r.CONT_COMP_NAME_C || '')).toLowerCase().includes(q));
      const row = r => ({ r, have: have.has(r.PROJ_ID) });
      const kids = new Map(); P.forEach(r => { if (r.PROJ_TYPE === '子') { if (!kids.has(r.PROJ_UP)) kids.set(r.PROJ_UP, []); kids.get(r.PROJ_UP).push(r); } });
      const groups = P.filter(r => r.PROJ_TYPE === '區' && (!dp || r.WORK_SECTION_ID === dp)).map(g => {
        const all = (kids.get(g.PROJ_ID) || []).sort((a, b) => a.PROJ_ID.localeCompare(b.PROJ_ID)), gHit = !q || (g.PROJ_ID + ' ' + g.PROJ_NAME_C).toLowerCase().includes(q);
        const items = all.filter(r => (!f.step || r.STEP_TYPE === f.step) && (gHit || ok(r))).map(row);
        return { g, items, n: all.length };
      }).filter(x => x.items.length).sort((a, b) => a.g.PROJ_ID.localeCompare(b.g.PROJ_ID));
      const singles = P.filter(r => r.PROJ_TYPE === '單' && (!dp || r.WORK_SECTION_ID === dp) && ok(r)).sort((a, b) => a.PROJ_ID.localeCompare(b.PROJ_ID)).map(row);
      const LIM = 300; let n = 0; const cut = arr => arr.filter(() => ++n <= LIM);
      groups.forEach(x => { x.items = cut(x.items); }); const s2 = cut(singles);
      return { groups: groups.filter(x => x.items.length), singles: s2, total: groups.reduce((a, x) => a + x.items.length, 0) + singles.length, more: n > LIM };
    });
    const pickSel = computed(() => pick.value ? Object.keys(pick.value.sel).filter(k => pick.value.sel[k]) : []);
    function pickGroupAll(x, on) { x.items.filter(i => !i.have).forEach(i => { pick.value.sel[i.r.PROJ_ID] = on; }); }
    async function doPick() {
      const P = window.QMS_PROJBASE, by = new Map(P.map(r => [r.PROJ_ID, r])), codes = pickSel.value; if (!codes.length) return toast('請勾選要加入的標案', true);
      const have = new Set(allTenders.value.map(t => t.code)), add = codes.filter(c => !have.has(c)).map(c => { const r = by.get(c); return Q.tenderFromProj(r, r.PROJ_UP ? by.get(r.PROJ_UP) : null); });
      await Q.putMany('tenders', add); pick.value = null; await load();
      if (add[0]) { selTenderId.value = add[0].id; swPick.value = null; grpOpen[add[0].parentCode || '_'] = true; }
      toast(`已加入 ${add.length} 個標案，請接著建立分項工程`);
    }

    /* ---------- 表單範本 ---------- */
    // 分項工程下拉：先依標號，再依項次(order)排列
    const swGroups = computed(() => d.tenders.slice().map(t => ({ tender: t, subs: d.subworks.filter(s => s.tenderId === t.id).sort((a, b) => a.order - b.order) })).filter(g => g.subs.length));
    const tplSw = ref('S671-5'), selTplId = ref(null), tplTab = ref('items'), edit = ref(null), previewOn = ref(false);
    // 單元（選用）：標案 → 分項工程 → [單元] → 表單
    const tplUnit = ref(''), unitForm = ref(null);
    const tplUnits = computed(() => (swById(tplSw.value) || {}).unitList || []);
    const unitTplN = (sid, u) => d.templates.filter(t => t.subworkId === sid && (t.unitNo || '') === u && t.status === 'published').length;
    const unitRecN = (sid, u) => d.selfChecks.filter(x => x.subworkId === sid && x.unit === u).length + d.spotChecks.filter(x => x.subworkId === sid && x.unit === u).length;
    function openUnitForm() { unitForm.value = { code: '', err: '' }; }
    async function addUnit() {
      const f = unitForm.value, code = f.code.trim(), sw = Q.clone(swById(tplSw.value)); if (!code) { f.err = '請輸入單元編號'; return; }
      const list = sw.unitList || []; if (list.some(u => u.toUpperCase() === code.toUpperCase())) { f.err = `單元編號「${code}」在此分項工程已存在`; return; }
      if (!list.length) {
        const lvl = d.templates.filter(t => t.subworkId === sw.id && !t.unitNo);
        if (lvl.length) { if (!confirm(`此分項工程目前有 ${lvl.length} 張表單範本掛在分項工程層。\n設定單元後，表單只能掛在單元下，這些表單將一併移到單元「${code}」。確定？`)) return; for (const t of lvl) { const c = Q.clone(t); c.unitNo = code; await Q.put('templates', c); } }
      }
      sw.unitList = list.concat(code); await Q.put('subworks', sw); await load(); f.code = ''; f.err = ''; toast(`已新增單元 ${code}`);
    }
    async function delUnit(u) {
      const n = unitTplN(tplSw.value, u), r = unitRecN(tplSw.value, u);
      if (n || r) return toast(`單元 ${u} 已有 ${n} 張表單範本${r ? `、${r} 筆填寫紀錄` : ''}，不可刪除`, true);
      const sw = Q.clone(swById(tplSw.value)); sw.unitList = (sw.unitList || []).filter(x => x !== u); await Q.put('subworks', sw); if (tplUnit.value === u) tplUnit.value = ''; await load(); toast(`已刪除單元 ${u}`);
    }
    // 分項工程有設定單元時，表單只能掛在單元下：單元選單沒有「不指定單元」，預設選第一個單元
    watch(tplUnits, u => { if (u.length && !u.includes(tplUnit.value)) tplUnit.value = u[0]; else if (!u.length && tplUnit.value) tplUnit.value = ''; });
    const tplList = kind => d.templates.filter(t => t.subworkId === tplSw.value && (t.unitNo || '') === tplUnit.value && t.kind === kind && t.status === 'published').sort((a, b) => (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order));
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
    const tplPickFirst = () => { const l = tplList('self')[0] || tplList('spot')[0]; if (l) pickTpl(l); else { selTplId.value = null; edit.value = null; } };
    watch(tplSw, () => { tplUnit.value = tplUnits.value[0] || ''; tplPickFirst(); });
    watch(tplUnit, tplPickFirst);
    watch(() => d.templates.length, () => { if (!edit.value && loaded.value) { const l = tplList('self')[0]; if (l) pickTpl(l); } });
    const editUsed = computed(() => edit.value ? usedCount(edit.value) : 0);
    const editStages = computed(() => edit.value ? Q.stagesOf(edit.value).map(s => ({ key: s.key, name: s.name, items: edit.value.items.map((it, idx) => ({ it, idx })).filter(x => x.it.stage === s.key) })) : []);
    /* ---------- 階段設定（每張表單可自訂，例：挖掘前／挖掘中／挖掘後） ---------- */
    const STAGE_PRESETS = [['施工前', '施工中', '施工後'], ['挖掘前', '挖掘中', '挖掘後'], ['施工前', '施工後']];
    const stageForm = ref(null);
    const stageItemN = key => edit.value ? edit.value.items.filter(i => i.stage === key).length : 0;
    function openStageForm() { stageForm.value = { rows: Q.clone(Q.stagesOf(edit.value)), err: '' }; }
    function stageAdd() { stageForm.value.rows.push({ key: Q.uid('ST'), name: '' }); }
    function stageMove(i, dir) { const r = stageForm.value.rows, j = i + dir; if (j < 0 || j >= r.length) return; const t = r[i]; r[i] = r[j]; r[j] = t; }
    function stageDel(i) { const r = stageForm.value.rows; if (stageItemN(r[i].key)) return toast(`「${r[i].name}」還有 ${stageItemN(r[i].key)} 個檢查項目，請先移除或改到其他階段`, true); if (r.length <= 1) return toast('至少要有一個階段', true); r.splice(i, 1); }
    function stagePreset(names) { const r = stageForm.value.rows; names.forEach((n, i) => { if (r[i]) r[i].name = n; else r.push({ key: Q.uid('ST'), name: n }); }); for (let i = r.length - 1; i >= names.length; i--) if (!stageItemN(r[i].key)) r.splice(i, 1); }
    function applyStages() {
      const f = stageForm.value, rows = f.rows.map(s => ({ key: s.key, name: s.name.trim() }));
      if (rows.some(s => !s.name)) { f.err = '階段名稱不可空白'; return; }
      if (new Set(rows.map(s => s.name)).size !== rows.length) { f.err = '階段名稱不可重複'; return; }
      edit.value.stages = rows; stageForm.value = null; toast('階段已更新，按「儲存」後生效');
    }
    // 依階段名稱對應 key；名稱不存在就新增階段（匯入用）
    function buildStages(names, base) {
      const out = Q.clone(base || []);
      names.forEach(n => { if (n && !out.some(s => s.name === n)) out.push({ key: SR[n] && !out.some(s => s.key === SR[n]) ? SR[n] : Q.uid('ST'), name: n }); });
      return out;
    }
    const stageKey = (stages, name) => (stages.find(s => s.name === name) || {}).key;
    const TYPES = { option: '選項', photo: '照片', text: '文字', linked: '連結表單' };
    const holdN = computed(() => edit.value ? edit.value.items.filter(i => i.hold).length : 0);
    function addItem(stage) { edit.value.items.push(Q.I(0, stage, '新檢查項目', '', { photo: false })); }
    function delItem(idx) { edit.value.items.splice(idx, 1); }
    function moveItem(idx, dir) {
      const arr = edit.value.items, it = arr[idx]; let j = idx + dir;
      while (j >= 0 && j < arr.length && arr[j].stage !== it.stage) j += dir;
      if (j < 0 || j >= arr.length) return; arr.splice(idx, 1); arr.splice(j, 0, it);
    }
    function onType(it) { if (it.type !== 'linked') it.linked = ''; else if (!it.linked) it.linked = (linkOpts.value[0] || {}).code || ''; }
    // 連結表單選項：同分項工程、已發布的其他自主檢查表（取代寫死的表5-4～5-9）
    const linkOpts = computed(() => !edit.value ? [] : [...new Map(d.templates.filter(t => t.kind === 'self' && t.status === 'published' && t.subworkId === edit.value.subworkId && t.code !== edit.value.code).map(t => [t.code, { code: t.code, name: t.name }])).values()]);
    const adminUser = computed(() => d.users.find(u => u.role === '系統管理員') || { name: '系統管理員', org: '' });
    function finalizeItems(t) {
      const order = Object.fromEntries(Q.stagesOf(t).map((s, i) => [s.key, i]));
      t.items = t.items.map((x, i) => [x, i]).sort((a, b) => (order[a[0].stage] ?? 99) - (order[b[0].stage] ?? 99) || a[1] - b[1]).map(x => x[0]);
      t.items.forEach((x, i) => { x.no = i + 1; if (t.kind === 'self' || !x.srcNo) x.srcNo = x.srcNo || x.no; if (!x.key) x.key = Q.uid('K'); });
      return t;
    }
    /* ---------- 匯入此分項全部表單（單元＋線上表單＋檢查項目，支援「共用＋單元覆蓋」） ---------- */
    const bulk = ref(null);
    const BULK_TYPE = { 選項: 'option', 照片: 'photo', 文字: 'text', 連結表單: 'linked' };
    const BULK_KIND = { 自主檢查表: 'self', 抽查紀錄表: 'spot' };
    function openBulk() { bulk.value = { fileName: '', err: '', units: [], forms: [], loose: [], sel: null, done: null }; }
    function bulkSheet(wb, name) {
      const ws = wb.Sheets[name]; if (!ws) return null;
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }); if (!rows.length) return [];
      const head = rows[0].map(h => String(h).replace(/\*/g, '').trim());
      return rows.slice(1).map((r, i) => { const o = { _line: i + 2 }; head.forEach((h, k) => { if (h) o[h] = typeof r[k] === 'string' ? r[k].trim() : r[k]; }); return o; });
    }
    const yn = v => /^y/i.test(String(v || '').trim());
        const splitList = v => String(v || '').replace(/[，,\s]+/g, '、').split('、').map(x => x.trim()).filter(Boolean);
    function onBulkFile(e) {
      const f = e.target.files[0]; if (!f) return; const b = bulk.value; Object.assign(b, { fileName: f.name, err: '', units: [], forms: [], loose: [], sel: null, done: null });
      const rd = new FileReader();
      rd.onload = () => { try { parseBook(XLSX.read(rd.result, { type: 'array' }), swById(tplSw.value), b); } catch (ex) { b.err = '無法讀取 Excel：' + ex.message; } };
      rd.readAsArrayBuffer(f); e.target.value = '';
    }
    function parseBook(wb, sw, b) {
      const swKey = Q.projKey(tenderById(sw && sw.tenderId));
      const shU = bulkSheet(wb, '單元') || [], shF = bulkSheet(wb, '表單'), shI = bulkSheet(wb, '檢查項目');
      if (!shF || !shI) { b.err = '找不到「表單」或「檢查項目」工作表，請使用「下載匯入範本」的格式'; return; }
      // 單元
      const sysUnits = sw.unitList || [], seenU = {};
      b.units = shU.filter(r => r['單元編號'] !== '' && r['單元編號'] != null).map(r => {
        const code = String(r['單元編號']).trim(), k = code.toUpperCase(), errs = [];
        if (seenU[k]) errs.push(`與第 ${seenU[k]} 列重複`); else seenU[k] = r._line;
        return { code, line: r._line, exists: sysUnits.some(u => u.toUpperCase() === k), errs };
      });
      const allUnits = sysUnits.concat(b.units.filter(u => !u.errs.length && !u.exists).map(u => u.code));
      const unitOf = c => allUnits.find(u => u.toUpperCase() === String(c).trim().toUpperCase());
      // 表單
      const fileSelf = shF.filter(r => r['表單類型'] === '自主檢查表').map(r => String(r['表號']));
      const sysSelf = c => d.templates.some(t => t.subworkId === sw.id && t.kind === 'self' && t.status === 'published' && t.code === c);
      const forms = [], byCode = {};
      shF.filter(r => r['表號'] !== '' && r['表號'] != null).forEach(r => {
        const code = String(r['表號']).trim(), errs = [], kind = BULK_KIND[r['表單類型']];
        if (byCode[code]) errs.push(`表單第 ${r._line} 列：表號 ${code} 重複`);
        if (!r['表單名稱']) errs.push(`表單第 ${r._line} 列：表單名稱不可空白`);
        if (!kind) errs.push(`表單第 ${r._line} 列：表單類型須為 自主檢查表／抽查紀錄表`);
        const ap = String(r['適用單元'] || '').trim(); let units = [''];
        if (!ap && allUnits.length) errs.push(`表單第 ${r._line} 列：此分項工程已設定單元，表單不可掛在分項工程層，「適用單元」請填單元編號或「全部」`);
        if (ap === '全部') { units = allUnits.slice(); if (!units.length) errs.push(`表單第 ${r._line} 列：適用單元填「全部」，但沒有任何單元`); }
        else if (ap) { units = []; splitList(ap).forEach(u => { const hit = unitOf(u); if (hit) units.push(hit); else errs.push(`表單第 ${r._line} 列：單元「${u}」不存在`); }); }
        const stNames = splitList(r['階段設定']);
        if (new Set(stNames).size !== stNames.length) errs.push(`表單第 ${r._line} 列：階段名稱重複`);
        const pair = String(r['配對自主檢查表號'] || '').trim();
        if (pair && kind !== 'spot') errs.push(`表單第 ${r._line} 列：配對自主檢查表號僅限抽查紀錄表`);
        if (pair && kind === 'spot' && !fileSelf.includes(pair) && !sysSelf(pair)) errs.push(`表單第 ${r._line} 列：配對自主檢查表號「${pair}」不存在`);
        const fm = { code, name: r['表單名稱'], kind, kindText: r['表單類型'], units, applyText: ap, stageNames: stNames.length ? stNames : Q.DEF_STAGES.map(x => x.name),
          source: r['來源依據'] || '', pair, order: r['排序'] === '' ? forms.length : Number(r['排序']), line: r._line, errs, items: [], views: {} };
        if (!byCode[code]) byCode[code] = fm; forms.push(fm);
      });
      forms.forEach(f => { if (forms.filter(x => x.code === f.code).length > 1 && !f.errs.some(e => e.includes('重複'))) f.errs.push(`表單第 ${f.line} 列：表號 ${f.code} 在「表單」工作表出現多次`); });
      // 檢查項目
      b.loose = [];
      const iSeen = {};
      shI.filter(r => r['表號'] !== '' && r['表號'] != null).forEach(r => {
        const code = String(r['表號']).trim(), fm = byCode[code], L = `檢查項目第 ${r._line} 列`;
        if (!fm) { b.loose.push(`${L}：表號 ${code} 不在「表單」工作表`); return; }
        const unit = r['單元編號'] === '' ? '' : String(r['單元編號']).trim(), no = Number(r['項次']), ex = yn(r['排除']), e = fm.errs;
        const u = unit ? unitOf(unit) : '';
        if (!no || no < 1 || !Number.isInteger(no)) { e.push(`${L}：項次需為正整數`); return; }
        if (unit && (!u || !fm.units.includes(u))) e.push(`${L}：單元「${unit}」不在此表單的適用單元內`);
        const k = `${u}|${no}`; if (iSeen[code + '#' + k]) e.push(`${L}：項次 ${no}${u ? '（' + u + '）' : ''} 重複`); iSeen[code + '#' + k] = 1;
        if (ex && !unit) e.push(`${L}：「排除」只能用在單元列`);
        const it = { unit: u, no, ex, line: r._line, stage: r['階段'], name: r['檢查項目'], std: r['檢查標準'] == null ? '' : String(r['檢查標準']), typeText: r['判定類型'], type: BULK_TYPE[r['判定類型']],
          hold: yn(r['停留點']), photo: yn(r['必拍照']), ref: String(r['引用文件編號'] || '').trim(), linked: String(r['連結表號'] || '').trim() };
        if (!ex) {
          if (!it.stage || !it.name || !it.typeText) e.push(`${L}：階段、檢查項目、判定類型必填`);
          if (it.stage && !fm.stageNames.includes(it.stage)) e.push(`${L}：階段「${it.stage}」不在此表單的階段（${fm.stageNames.join('／')}）`);
          if (it.typeText && !it.type) e.push(`${L}：判定類型「${it.typeText}」須為 選項／照片／文字／連結表單`);
          if (it.ref && !d.docs.some(x => x.code === it.ref && x.projKey === swKey)) e.push(`${L}：引用文件編號「${it.ref}」不存在於 ${swKey} 的參考文件`);
          if (it.type === 'linked' && !it.linked) e.push(`${L}：判定類型為連結表單時須填連結表號`);
          if (it.linked && !fileSelf.includes(it.linked) && !sysSelf(it.linked)) e.push(`${L}：連結表號「${it.linked}」不存在`);
        }
        fm.items.push(it);
      });
      for (const fm of forms) fm.items.filter(i => i.ex && i.unit).forEach(i => { if (!fm.items.some(x => !x.unit && x.no === i.no)) fm.errs.push(`檢查項目第 ${i.line} 列：排除的項次 ${i.no} 沒有對應的共用項目`); });
      // 依單元展開（共用＋單元覆蓋），並檢查展開後的結果
      forms.forEach(fm => {
        fm.units.forEach(u => {
          const map = new Map();
          fm.items.filter(i => !i.unit).forEach(i => map.set(i.no, Object.assign({ src: '共用' }, i)));
          fm.items.filter(i => u && i.unit === u).forEach(i => { if (i.ex) map.delete(i.no); else map.set(i.no, Object.assign({ src: map.has(i.no) ? '覆蓋' : '單元新增' }, i)); });
          const order = fm.stageNames;
          const items = [...map.values()].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || a.no - b.no);
          const where = u ? `（單元 ${u}）` : '';
          if (!items.length) fm.errs.push(`表單 ${fm.code}${where}：沒有任何檢查項目`);
          const old = d.templates.filter(t => t.subworkId === sw.id && (t.unitNo || '') === u && t.code === fm.code && t.status === 'published').sort((a, b) => b.version - a.version)[0];
          if (old && old.kind !== fm.kind) fm.errs.push(`表單 ${fm.code}${where}：系統已有同表號但類型不同的表單`);
          if (old && old.fillMode === 'pdf') fm.errs.push(`表單 ${fm.code}${where}：系統已有同表號的空白範本 PDF 表單，不可用線上表單覆蓋`);
          fm.views[u] = { items, old, action: !old ? '新增' : usedCount(old) ? `另存 v${old.version + 1}` : `更新 v${old.version}` };
        });
        fm.errs = [...new Set(fm.errs)];
      });
      b.forms = forms.sort((a, b) => a.order - b.order);
      const f0 = b.forms[0]; b.sel = f0 ? { code: f0.code, unit: f0.units[0] } : null;
    }
    const bulkOk = computed(() => bulk.value ? bulk.value.forms.filter(f => !f.errs.length) : []);
    const bulkView = computed(() => { const b = bulk.value; if (!b || !b.sel) return null; const fm = b.forms.find(f => f.code === b.sel.code); return fm && fm.views[b.sel.unit] ? { fm, v: fm.views[b.sel.unit] } : null; });
    async function doBulk() {
      const b = bulk.value, sw = Q.clone(swById(tplSw.value)), ok = bulkOk.value; if (!ok.length) return toast('沒有可匯入的表單', true);
      const newUnits = b.units.filter(u => !u.errs.length && !u.exists).map(u => u.code);
      if (newUnits.length) { sw.unitList = (sw.unitList || []).concat(newUnits); await Q.put('subworks', sw); }
      const res = { add: 0, upd: 0, ver: 0, units: newUnits.length }, saved = [];
      // 自主檢查表先建，抽查表的配對才找得到
      for (const fm of ok.slice().sort((a, b) => (a.kind === 'spot') - (b.kind === 'spot'))) {
        for (const u of fm.units) {
          const v = fm.views[u], old = v.old;
          const stages = fm.stageNames.map(n => { const o = old && Q.stagesOf(old).find(s => s.name === n); return o ? { key: o.key, name: n } : { key: SR[n] || Q.uid('ST'), name: n }; });
          // 同名項目沿用舊的永久代碼（key），讓抽查表對應與統計不中斷
          const items = v.items.map((i, k) => { const prev = old && old.items.find(x => x.name === i.name); return Object.assign(Q.I(k + 1, stages.find(s => s.name === i.stage).key, i.name, i.std, { type: i.type, hold: !!i.hold, photo: !!i.photo || i.type === 'photo', ref: i.ref, linked: i.type === 'linked' ? i.linked : '' }), prev && prev.key ? { key: prev.key } : {}); });
          let pairedSelf = '';
          if (fm.pair) { const sp = d.templates.concat(saved).filter(t => t.subworkId === sw.id && t.kind === 'self' && t.status === 'published' && t.code === fm.pair).sort((a, b) => ((b.unitNo || '') === u) - ((a.unitNo || '') === u) || b.version - a.version)[0]; pairedSelf = sp ? sp.id : ''; }
          const base = { tenderId: sw.tenderId, subworkId: sw.id, unitNo: u, kind: fm.kind, code: fm.code, name: fm.name, source: fm.source || ('匯入：' + b.fileName), fillMode: 'online', stages, items, order: fm.order, pairedSelf };
          let t;
          if (!old) { t = Object.assign({ id: Q.uid('TP-'), version: 1, status: 'published', used: 0 }, base); await Q.put('templates', Q.ensureKeys(t)); res.add++; }
          else if (usedCount(old)) { t = await Q.saveTemplate(Object.assign(Q.clone(old), base), true); res.ver++; }
          else { t = Object.assign(Q.clone(old), base); await Q.put('templates', Q.ensureKeys(t)); res.upd++; }
          saved.push(t);
        }
      }
      await load(); b.done = res;
      toast(`匯入完成：新增 ${res.add} 張、更新 ${res.upd} 張、另存新版 ${res.ver} 張${res.units ? `，新增單元 ${res.units} 個` : ''}`);
      tplPickFirst();
    }
    // 匯出目前內容：本分項工程全部線上表單（自主檢查表＋抽查紀錄表），格式與匯入範本相同，可修改後整批匯入
    // 同表號建在多個單元時，還原成「共用＋單元覆蓋」：第一個單元的內容當共用列，其他單元只寫差異（覆蓋／新增／排除）
    function exportSubwork() {
      const sw = swById(tplSw.value), unitOrder = sw.unitList || [];
      const tpls = d.templates.filter(t => t.subworkId === sw.id && t.status === 'published' && t.fillMode !== 'pdf');
      const groups = new Map(); tpls.forEach(t => { if (!groups.has(t.code)) groups.set(t.code, []); groups.get(t.code).push(t); });
      const out = { 單元: unitOrder.map(u => [u, '']), 表單: [], 檢查項目: [], 可連結表單: linkableRows(sw.id) }, skipped = [];
      const sameItem = (a, ta, b, tb) => Q.stageName(ta, a.stage) === Q.stageName(tb, b.stage) && (a.std || '') === (b.std || '') && a.type === b.type && !!a.hold === !!b.hold && !!a.photo === !!b.photo && (a.ref || '') === (b.ref || '') && (a.linked || '') === (b.linked || '');
      const itemRow = (t, u, no, i) => [t.code, u, no, Q.stageName(t, i.stage), i.name, i.std || '', TYPE_TEXT[i.type] || '選項', i.hold ? 'Y' : 'N', i.photo ? 'Y' : 'N', i.ref || '', i.linked || '', ''];
      [...groups.values()].sort((a, b) => (a[0].order ?? 1e9) - (b[0].order ?? 1e9) || a[0].code.localeCompare(b[0].code, 'zh-Hant', { numeric: true })).forEach(list => {
        const unitT = list.filter(t => t.unitNo).sort((a, b) => unitOrder.indexOf(a.unitNo) - unitOrder.indexOf(b.unitNo)), lvl = list.filter(t => !t.unitNo);
        if (unitT.length && lvl.length) skipped.push(list[0].code);
        const set = unitT.length ? unitT : lvl.slice(0, 1), base = set[0], code = base.code;
        // 階段：以共用版本為準，其他單元多出的階段接在後面
        const stNames = []; set.forEach(t => Q.stagesOf(t).forEach(st => { if (!stNames.includes(st.name)) stNames.push(st.name); }));
        const isDef = stNames.join() === Q.DEF_STAGES.map(x => x.name).join();
        const pair = base.pairedSelf ? (d.templates.find(x => x.id === base.pairedSelf) || {}).code || '' : '';
        out.表單.push([code, base.name, base.kind === 'spot' ? '抽查紀錄表' : '自主檢查表', unitT.length ? unitT.map(t => t.unitNo).join('、') : '', base.source || '', pair, '', isDef ? '' : stNames.join('、')]);
        // 共用列＝第一個（或唯一的）版本；其他單元只寫差異。先用 1、2、3 編項次，模擬匯入後順序若和系統不同，改用 10、20、30 留空位讓單元新增項目插在正確位置
        const stIdx = n => { const k = stNames.indexOf(n); return k < 0 ? 99 : k; };
        const layout = step => {
          const I = [], shared = base.items.map((i, k) => ({ no: (k + 1) * step, i }));
          shared.forEach(x => I.push(itemRow(base, '', x.no, x.i)));
          for (const t of set.slice(1)) {
            const u = t.unitNo, used = new Set(), pairOf = new Array(t.items.length).fill(-1);
            t.items.forEach((i, ui) => { const bk = base.items.findIndex((b, k) => !used.has(k) && b.name === i.name); if (bk >= 0) { pairOf[ui] = bk; used.add(bk); } });
            // 名稱改了的項目：同位置、同階段、都沒配到 → 視為覆蓋（同項次）
            // 名稱改了的項目：在前後兩個已配對項目之間、同階段、還沒配到的原項目 → 視為覆蓋（同項次）
            t.items.forEach((i, ui) => {
              if (pairOf[ui] >= 0) return;
              let p = -1, q = base.items.length; for (let k = ui - 1; k >= 0; k--) if (pairOf[k] >= 0) { p = pairOf[k]; break; } for (let k = ui + 1; k < t.items.length; k++) if (pairOf[k] >= 0) { q = pairOf[k]; break; }
              const bk = base.items.findIndex((b, k) => k > p && k < q && !used.has(k) && Q.stageName(base, b.stage) === Q.stageName(t, i.stage));
              if (bk >= 0) { pairOf[ui] = bk; used.add(bk); }
            });
            base.items.forEach((b, k) => { if (!used.has(k)) I.push([code, u, shared[k].no, '', '', '', '', '', '', '', '', 'Y']); });
            let prevNo = null, prevStage = null, off = 0, nextPlain = base.items.length;
            for (let ui = 0; ui < t.items.length; ui++) {
              const i = t.items[ui], stn = Q.stageName(t, i.stage);
              if (pairOf[ui] >= 0) {
                const bk = pairOf[ui], b = base.items[bk], no = shared[bk].no; prevNo = no; prevStage = stn; off = 0;
                if (b.name !== i.name || !sameItem(i, t, b, base)) I.push(itemRow(t, u, no, i));
                continue;
              }
              let no;
              if (step === 1) no = ++nextPlain;
              else {
                if (prevStage !== stn) { const first = shared.find(x => Q.stageName(base, x.i.stage) === stn); prevNo = (first ? first.no : (base.items.length + 1) * step) - step; prevStage = stn; off = 0; }
                no = prevNo + (++off); if (off >= step) return null;
              }
              I.push(itemRow(t, u, no, i));
            }
          }
          return { I };
        };
        // 模擬匯入：依「共用＋單元覆蓋」展開後，項目順序要和系統內每個版本一致
        const simulate = (L, t) => {
          const m = new Map(); L.I.filter(r => r[1] === '').forEach(r => m.set(r[2], r));
          if (t.unitNo && t !== base) L.I.filter(r => r[1] === t.unitNo).forEach(r => { if (r[11] === 'Y') m.delete(r[2]); else m.set(r[2], r); });
          return [...m.values()].sort((a, b) => stIdx(a[3]) - stIdx(b[3]) || a[2] - b[2]).map(r => r[4]).join('\u0001');
        };
        let L = null;
        for (const step of [1, 10, 100]) { const c = layout(step); if (c && set.every(t => simulate(c, t) === t.items.map(i => i.name).join('\u0001'))) { L = c; break; } }
        if (!L) L = layout(100) || layout(1);
        out.檢查項目.push(...L.I);
      });
      if (!out.表單.length) return toast('本分項工程尚無線上表單可匯出', true);
      if (buildXlsx(out, `${sw.no || ''}${sw.name || ''}_全部表單.xlsx`, `分項工程表單匯出：${sw.no || ''}、${sw.name || ''}`,
        `由系統「匯出目前內容」產生，含本分項工程全部線上表單（${out.表單.length} 張）。同表號建在多個單元時以「共用＋單元覆蓋」表示。修改後可用「匯入此分項全部表單」匯入；空白範本 PDF 不在匯出範圍。`))
        toast(`已匯出 ${out.表單.length} 張表單` + (skipped.length ? `；表號 ${skipped.join('、')} 同時建在分項工程層與單元下，只匯出單元版本` : ''), !!skipped.length);
    }
    // 空白範本（含範例資料）：連續壁工程的示範內容，看完範例可清掉後填自己的表單
    function downloadBulkSample() { const a = document.createElement('a'); a.href = 'templates/分項工程表單匯入範本.xlsx'; a.download = '分項工程表單匯入範本（含範例資料）.xlsx'; document.body.appendChild(a); a.click(); a.remove(); }
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
      { const st = Q.clone(Q.stagesOf(edit.value)); Q.stagesOf(self).forEach(s => { const hit = st.find(x => x.key === s.key); if (hit) hit.name = s.name; else st.push(Q.clone(s)); }); edit.value.stages = st; }
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
      const sw = swById(tplSw.value); if (tplUnits.value.length && !tplUnit.value) return toast('此分項工程已設定單元，表單必須掛在單元下，請先選擇單元', true);
      const t = { id: Q.uid('TP-'), tenderId: sw.tenderId, subworkId: sw.id, unitNo: tplUnit.value, kind: f.kind, code: f.code.trim() || (f.kind === 'self' ? '新表' : 'SP-新'), name: f.name.trim(), version: 1, status: 'published', source: f.fillMode === 'pdf' ? '空白範本 PDF' : '', fillMode: f.fillMode, pdf: f.fillMode === 'pdf' ? f.pdf : null, items: f.fillMode === 'pdf' ? [] : [Q.I(1, 'pre', '新檢查項目', '')], used: 0 };
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
    const RT = { 選項: 'option', 照片: 'photo', 文字: 'text', 連結表單: 'linked' }, SR = { 施工前: 'pre', 施工中: 'during', 施工後: 'post' };
    /* ---------- 單張表單的匯出／匯入檢查項目：與「匯入此分項全部表單」同一個 Excel 格式 ---------- */
    const XH = {
      unit: ['單元編號 *', '說明'],
      form: ['表號 *', '表單名稱 *', '表單類型 *', '適用單元', '來源依據', '配對自主檢查表號', '排序', '階段設定'],
      item: ['表號 *', '單元編號', '項次 *', '階段 *', '檢查項目 *', '檢查標準', '判定類型 *', '停留點', '必拍照', '引用文件編號', '連結表號', '排除'],
      field: ['表號 *', '單元編號', '項次 *', '欄位名稱 *', '單位', '下限', '上限', '排除']
    };
    const TYPE_TEXT = { option: '選項', photo: '照片', text: '文字', linked: '連結表單' };
    // 本分項工程系統內的自主檢查表（含 PDF）：給 Excel「可連結表單」工作表，做為連結表號／配對表號的下拉清單
    function linkableRows(swId) {
      const m = new Map();
      d.templates.filter(t => t.subworkId === swId && t.kind === 'self' && t.status === 'published').sort((a, b) => a.code.localeCompare(b.code, 'zh-Hant', { numeric: true })).forEach(t => {
        const r = m.get(t.code) || { code: t.code, name: t.name, units: new Set(), pdf: t.fillMode === 'pdf' }; r.units.add(t.unitNo || '（分項工程層）'); m.set(t.code, r);
      });
      return [...m.values()].map(r => [r.code, r.name, [...r.units].join('、'), r.pdf ? '空白範本 PDF' : '線上表單']);
    }
    // 以內建底稿（與匯入範本相同的填寫說明、欄位、檢查公式、下拉選單）產生 Excel，再把資料填進去
    function buildXlsx(data, fileName, title, sub) {
      if (!window.QMS_EXPORT_TPL) return toast('匯出底稿未載入', true);
      const u8 = Uint8Array.from(atob(window.QMS_EXPORT_TPL), c => c.charCodeAt(0)), cfb = XLSX.CFB.read(u8, { type: 'array' });
      const ent = p => XLSX.CFB.find(cfb, p), rd = p => new TextDecoder().decode(ent(p).content), wr = (p, x) => { ent(p).content = new TextEncoder().encode(x); };
      const dp = new DOMParser(), xs0 = new XMLSerializer(), NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
      const xs = { serializeToString: d => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xs0.serializeToString(d) };
      // 工作表名稱 → 檔案路徑
      const wbDoc = dp.parseFromString(rd('/xl/workbook.xml'), 'application/xml'), relDoc = dp.parseFromString(rd('/xl/_rels/workbook.xml.rels'), 'application/xml');
      const relOf = {}; [...relDoc.getElementsByTagName('Relationship')].forEach(r => { relOf[r.getAttribute('Id')] = r.getAttribute('Target').replace(/^\/?(xl\/)?/, ''); });
      const pathOf = {}; [...wbDoc.getElementsByTagName('sheet')].forEach(sh => { pathOf[sh.getAttribute('name')] = '/xl/' + relOf[sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')]; });
      // 列印範圍＝實際資料列；資料範圍（dimension）涵蓋公式欄
      const PRINT = { 單元: 'B', 表單: 'M', 檢查項目: 'N', 可連結表單: 'E' }, DIM = Object.assign({}, PRINT, { 可連結表單: 'O' }), sheetEls = [...wbDoc.getElementsByTagName('sheet')];
      let dn = wbDoc.getElementsByTagName('definedNames')[0];
      if (!dn) { dn = wbDoc.createElementNS(NS, 'definedNames'); const sheetsEl = wbDoc.getElementsByTagName('sheets')[0]; sheetsEl.parentNode.insertBefore(dn, sheetsEl.nextSibling); }
      [...dn.getElementsByTagName('definedName')].filter(x => x.getAttribute('name') === '_xlnm.Print_Area').forEach(x => dn.removeChild(x));
      Object.keys(PRINT).forEach(name => { const idx = sheetEls.findIndex(x => x.getAttribute('name') === name); if (idx < 0) return; const el = wbDoc.createElementNS(NS, 'definedName'); el.setAttribute('name', '_xlnm.Print_Area'); el.setAttribute('localSheetId', String(idx)); const n = name === '可連結表單' ? (data[name] || []).length + (data.表單 || []).filter(r => r[2] === '自主檢查表' && !(data[name] || []).some(x => x[0] === r[0])).length : (data[name] || []).length; el.textContent = `'${name}'!$A$1:$${PRINT[name]}$${Math.max(n + 1, 2)}`; dn.appendChild(el); });
      // 開啟時重新計算公式
      let calc = wbDoc.getElementsByTagName('calcPr')[0]; if (!calc) { calc = wbDoc.createElementNS(NS, 'calcPr'); wbDoc.documentElement.appendChild(calc); } calc.setAttribute('fullCalcOnLoad', '1'); wr('/xl/workbook.xml', xs.serializeToString(wbDoc));
      // 樣式參考格：代碼表!H1 一般列、H2 單元列、H3 自動欄位
      const cdDoc = dp.parseFromString(rd(pathOf['代碼表']), 'application/xml'), styleOf = ref => { const c = [...cdDoc.getElementsByTagName('c')].find(x => x.getAttribute('r') === ref); return c ? c.getAttribute('s') : null; };
      const ST = { norm: styleOf('H1'), unit: styleOf('H2'), auto: styleOf('H3') };
      const col = n => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
      const colIdx = ref => ref.replace(/\d+/g, '').split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const setVal = (doc, c, v) => {
        while (c.firstChild) c.removeChild(c.firstChild);
        if (v === '' || v == null) { c.removeAttribute('t'); return; }
        if (typeof v === 'number') { c.removeAttribute('t'); const ve = doc.createElementNS(NS, 'v'); ve.textContent = String(v); c.appendChild(ve); }
        else { c.setAttribute('t', 'inlineStr'); const is = doc.createElementNS(NS, 'is'), te = doc.createElementNS(NS, 't'); te.setAttribute('xml:space', 'preserve'); te.textContent = String(v); is.appendChild(te); c.appendChild(is); }
      };
      // 填寫說明的標題與說明文字
      { const doc = dp.parseFromString(rd(pathOf['填寫說明']), 'application/xml'), cs = [...doc.getElementsByTagName('c')];
        [['B2', title], ['B3', sub]].forEach(([ref, v]) => { const c = cs.find(x => x.getAttribute('r') === ref); if (c && v) setVal(doc, c, v); });
        wr(pathOf['填寫說明'], xs.serializeToString(doc)); }
      Object.entries(data).forEach(([name, rows]) => {
        const doc = dp.parseFromString(rd(pathOf[name]), 'application/xml'), sd = doc.getElementsByTagName('sheetData')[0];
        const rowEls = {}; [...sd.getElementsByTagName('row')].forEach(r => { rowEls[r.getAttribute('r')] = r; });
        [...sd.getElementsByTagName('f')].forEach(fe => { const v = fe.parentNode.getElementsByTagName('v')[0]; if (v) v.parentNode.removeChild(v); fe.parentNode.removeAttribute('t'); });
        const OFF = name === '可連結表單' ? 11 : 0;   // 可連結表單：系統現有資料寫在隱藏的 L–O 欄，看得到的 A–E 欄是公式
        rows.forEach((vals, k) => {
          const rn = String(k + 2), unitRow = name === '檢查項目' && !!vals[1];
          let row = rowEls[rn]; if (!row) { row = doc.createElementNS(NS, 'row'); row.setAttribute('r', rn); const after = [...sd.getElementsByTagName('row')].find(x => +x.getAttribute('r') > +rn); sd.insertBefore(row, after || null); }
          const cells = {}; [...row.getElementsByTagName('c')].forEach(c => { cells[colIdx(c.getAttribute('r'))] = c; });
          Object.entries(cells).forEach(([ci, c]) => { if (name !== '可連結表單' && +ci >= vals.length && ST.auto) c.setAttribute('s', ST.auto); });   // 灰底自動欄位
          vals.forEach((v, ci) => {
            const cx = ci + OFF; let c = cells[cx];
            if (!c) { c = doc.createElementNS(NS, 'c'); c.setAttribute('r', col(cx) + rn); const after = [...row.getElementsByTagName('c')].find(x => colIdx(x.getAttribute('r')) > cx); row.insertBefore(c, after || null); }
            const st = name === '可連結表單' ? null : unitRow ? ST.unit : ST.norm; if (st) c.setAttribute('s', st);
            setVal(doc, c, v);
          });
        });
        // 更新工作表的資料範圍（dimension），否則新增的列可能被讀檔程式忽略
        const dim = doc.getElementsByTagName('dimension')[0], lastRow = Math.max(rows.length + 1, ...[...sd.getElementsByTagName('row')].map(r => +r.getAttribute('r')));
        if (dim) dim.setAttribute('ref', `A1:${DIM[name]}${lastRow}`);
        wr(pathOf[name], xs.serializeToString(doc));
      });
      const out = XLSX.CFB.write(cfb, { type: 'array', fileType: 'zip' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      a.download = fileName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      return true;
    }
    // 匯出 Excel：目前這張表單
    function exportXlsx() {
      const t = edit.value, sw = swById(t.subworkId), stNames = Q.stagesOf(t).map(s => s.name), isDef = stNames.join() === Q.DEF_STAGES.map(s => s.name).join();
      const pair = t.pairedSelf ? (d.templates.find(x => x.id === t.pairedSelf) || {}).code || '' : '';
      const data = {
        單元: t.unitNo ? [[t.unitNo, '']] : [],
        表單: [[t.code, t.name, t.kind === 'spot' ? '抽查紀錄表' : '自主檢查表', t.unitNo || '', t.source || '', pair, '', isDef ? '' : stNames.join('、')]],
        檢查項目: t.items.map(i => [t.code, '', i.no, Q.stageName(t, i.stage), i.name, i.std || '', TYPE_TEXT[i.type] || '選項', i.hold ? 'Y' : 'N', i.photo ? 'Y' : 'N', i.ref || '', i.linked || '', '']),
        可連結表單: linkableRows(t.subworkId)
      };
      if (buildXlsx(data, `${t.code}_${t.name}${t.unitNo ? '_' + t.unitNo : ''}.xlsx`, `表單匯出檔：${t.kind === 'self' ? '表' : ''}${t.code} ${t.name}${t.unitNo ? '（單元 ' + t.unitNo + '）' : ''}`,
        `由系統「匯出 Excel」產生（${sw.no || ''}、${sw.name || ''}），欄位、檢查欄與規則和「分項工程表單匯入範本」相同。修改後可用表單範本的「匯入檢查項目」或「匯入此分項全部表單」匯入。`))
        toast('已匯出（含填寫說明、檢查欄與可連結表單）');
    }
    const itemImp = ref(null);
    function openItemImp() { itemImp.value = { fileName: '', err: '', res: null, code: '', unit: '', mode: 'replace' }; }
    function onItemFile(e) {
      const f = e.target.files[0]; if (!f) return; const m = itemImp.value; Object.assign(m, { fileName: f.name, err: '', res: null }); const rd = new FileReader();
      rd.onload = () => {
        try {
          const res = { units: [], forms: [], loose: [], err: '' }; parseBook(XLSX.read(rd.result, { type: 'array' }), swById(edit.value.subworkId), res);
          if (res.err) { m.err = res.err; return; } if (!res.forms.length) { m.err = '「表單」工作表沒有資料'; return; }
          const fm = res.forms.find(x => x.code === edit.value.code) || res.forms[0];
          m.res = res; m.code = fm.code; m.unit = fm.units.includes(edit.value.unitNo || '') ? (edit.value.unitNo || '') : fm.units[0];
        } catch (ex) { m.err = '無法讀取 Excel：' + ex.message; }
      };
      rd.readAsArrayBuffer(f); e.target.value = '';
    }
    const itemImpForm = computed(() => { const m = itemImp.value; return m && m.res ? m.res.forms.find(x => x.code === m.code) : null; });
    const itemImpView = computed(() => { const fm = itemImpForm.value; return fm && fm.views[itemImp.value.unit] ? fm.views[itemImp.value.unit] : null; });
    // 單張匯入只看這張表單本身的錯誤（不檢查「系統已有同表號」這類整批匯入才需要的規則）
    const itemImpErrs = computed(() => { const fm = itemImpForm.value; if (!fm) return []; const e = fm.errs.filter(x => !/系統已有同表號/.test(x)); if (fm.kind && fm.kind !== edit.value.kind) e.push(`檔案中的表單類型為「${fm.kindText}」，與目前編輯的表單不同`); return e; });
    function doItemImp() {
      const m = itemImp.value, fm = itemImpForm.value, v = itemImpView.value; if (!fm || !v || itemImpErrs.value.length) return toast('有錯誤，無法匯入', true);
      const t = edit.value, base = m.mode === 'replace' ? [] : Q.stagesOf(t);
      // 階段：沿用同名階段的 key，其餘依檔案的階段設定新增
      const stages = m.mode === 'replace' ? fm.stageNames.map(n => { const o = Q.stagesOf(t).find(s => s.name === n); return o ? Q.clone(o) : { key: SR[n] || Q.uid('ST'), name: n }; }) : buildStages(fm.stageNames, base);
      const items = v.items.map(i => { const prev = t.items.find(x => x.name === i.name); return Object.assign(Q.I(0, stageKey(stages, i.stage), i.name, i.std, { type: i.type, hold: !!i.hold, photo: !!i.photo || i.type === 'photo', ref: i.ref, linked: i.type === 'linked' ? i.linked : '' }), m.mode === 'replace' && prev && prev.key ? { key: prev.key } : {}); });
      t.stages = stages; t.items = m.mode === 'replace' ? items : t.items.concat(items);
      toast(`已匯入 ${items.length} 項（${m.mode === 'replace' ? '取代原有項目' : '加在現有項目後面'}），請按「${editUsed.value > 0 ? '另存為 v' + (t.version + 1) : '儲存'}」生效`); itemImp.value = null;
    }

    /* ---------- 其他 ---------- */
    const docForm = ref(null), userForm = ref(null);
    // 參考文件：以區段標／單一標為鍵值，可依此篩選；範本項目只能引用同一區段標／單一標的文件
    const docProj = ref('');
    const docList = computed(() => d.docs.filter(x => !docProj.value || x.projKey === docProj.value).sort((a, b) => (a.projKey || '').localeCompare(b.projKey || '') || a.code.localeCompare(b.code)));
    const editProj = computed(() => edit.value ? Q.projKey(tenderById((swById(edit.value.subworkId) || {}).tenderId || edit.value.tenderId)) : '');
    const refDocs = computed(() => d.docs.filter(x => x.projKey === editProj.value).sort((a, b) => a.code.localeCompare(b.code)));
    // 參考文件：可上傳檔案（PDF、Word、Excel、圖檔等，上限 20 MB），現場作業可下載
    function newDoc() { docForm.value = { id: '', code: '', name: '', note: '', projKey: docProj.value || (projOpts.value[0] || {}).v || '', file: null, isNew: true }; }
    function editDoc(x) { docForm.value = Object.assign(Q.clone(x), { isNew: false }); }
    async function onDocFile(e) {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      if (f.size > 20 * 1048576) return toast('檔案過大（上限 20 MB）', true);
      docForm.value.file = { name: f.name, size: f.size, type: f.type, data: await Q.fileToDataUrl(f), at: Date.now() };
      if (!docForm.value.name.trim()) docForm.value.name = f.name.replace(/\.[^.]+$/, '');
    }
    async function saveDoc() {
      const x = docForm.value; if (!x.projKey) return toast('請選擇區段標／單一標', true); if (!x.code.trim()) return toast('請輸入文件編號', true); if (!x.name.trim()) return toast('請輸入文件名稱', true);
      if (x.isNew && await Q.get('docs', x.code.trim())) return toast('文件編號已存在', true);
      const rec = { id: x.isNew ? x.code.trim() : x.id, code: x.isNew ? x.code.trim() : x.code, name: x.name.trim(), note: x.note || '', projKey: x.projKey, file: x.file || null };
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
    /* ---------- 查詢統計：批次下載（表單版面 PDF） ---------- */
    const JS = { ok: '○', ng: '╳', na: '╱' };
    const isImg = u => typeof u === 'string' && /^data:image\//.test(u);
    // 依紙本格式排出表單版面（HTML），交給 FormPDF 轉成 A4 PDF
    //   自主檢查表：表號名稱／廠商名稱／施工自主檢查表 → 表頭 → 檢查項目（階段直書）→ 缺失複查結果 → 備註 → 簽認
    //   抽查記錄表：工程處／表單名稱 → 表頭 → 抽查項目 → 單元計價 → 缺失複查結果 → 備註 → 簽認
    function formHtml(kind, r) {
      const E = FormPDF.esc, t = tplOf(r.templateId) || { items: [] }, tender = d.tenders.find(x => x.id === r.tenderId) || {}, sw = d.subworks.find(x => x.id === r.subworkId) || {};
      const self = kind === 'self', ans = r.answers || {}, sig = r.signatures || {};
      const box = on => on ? '☑' : '□', vt = txt => [...String(txt || '')].map(E).join('<br>');
      const swName = (sw.name || r.subworkName || '') + (r.unit ? `　單元：${r.unit}` : '');
      const dateTxt = Q.fmtD(r.date || r.createdAt);
      const hdr = rows => `<table class="hd"><colgroup><col style="width:17%"><col style="width:43%"><col style="width:14%"><col style="width:26%"></colgroup>${rows.map(row => `<tr data-brk>${row}</tr>`).join('')}</table>`;
      const L = txt => `<td class="k">${txt}</td>`, full = (k, v) => L(k) + `<td colspan="3">${v}</td>`;
      let h;
      if (self) {
        h = `<div class="t1" data-brk>表${E(r.templateCode)}　${E(r.templateName)}</div><div class="t2" data-brk>${E(r.contractor || tender.contractor || '')}</div><div class="t3" data-brk>施工自主檢查表</div>`;
        const used = new Set(t.items.filter(i => (ans[i.no] || {}).judge).map(i => i.stage));
        h += hdr([
          full('工程名稱', E(tender.parentName || tender.name)), full('分項工程名稱', E(swName)),
          L('檢查位置') + `<td>${E(r.location || '')}</td>` + L('檢查日期') + `<td>${E(dateTxt)}</td>`,
          full('施工流程', Q.stagesOf(t).map(st => `${box(used.has(st.key))}${E(st.name)}`).join('　　')),
          full('檢查結果', '○檢查合格　　　╳有缺失需改正　　　╱無此檢查項目')
        ]);
      } else {
        h = `<div class="t2" data-brk>${E(tender.supervisor || '臺北市政府捷運工程局')}</div><div class="t3 b" data-brk>${E(r.templateName)}</div>`;
        h += hdr([
          full('工程名稱', E(tender.parentName || tender.name)), full('施工廠商', E(r.contractor || tender.contractor)), full('分項工程名稱', E(swName)),
          L('抽查位置') + `<td>${E(r.location || '')}</td>` + L('檢查日期') + `<td>${E(dateTxt)}</td>`,
          full('抽查時機', `${box(r.kind === 'hold')}檢驗停留點${r.kind === 'hold' && r.title ? `（★${E(r.title)}）` : ''}　　　${box(r.kind !== 'hold')}隨機抽查`),
          full('抽查結果符號說明', '○ 檢查合格　　　╳ 有缺失需改正　　　╱ 無此檢查項目')
        ]);
      }
      if (r.fillMode === 'pdf') {
        h += `<div class="blk" data-brk>此表單以「空白範本 PDF」填寫，辦理狀態：${E(r.wfStatus || '—')}。${r.pdfFile ? '' : '尚未上傳簽名後的 PDF。'}</div>`;
        return h;
      }
      // 抽查：帶入同單元廠商自檢的判定，放在備註欄供對照
      const sc = !self && r.scId ? d.selfChecks.find(x => x.id === r.scId) : null, st = sc && tplOf(sc.templateId);
      const selfAns = it => { if (!sc) return null; const si = st && it.srcKey && st.items.find(x => x.key === it.srcKey); return sc.answers[si ? si.no : (it.srcNo || it.no)] || null; };
      const cols = [5, 18, 26, 25, 8, 18];
      h += `<table class="it"><colgroup>${cols.map(w => `<col style="width:${w}%">`).join('')}</colgroup>`;
      h += self ? `<tr data-brk><th colspan="2">檢查項目</th><th>設計圖說、規範之檢查標準<br>(定量定性)</th><th>實際檢查情形<br>(敘述檢查值)</th><th>檢查<br>結果</th><th>備註<br>(檢查人員)</th></tr>`
                : `<tr data-brk><th colspan="2">抽查項目</th><th>設計圖說、規範之<br>抽查標準（定性定量）</th><th>實際抽查情形<br>（敘述抽查情形）</th><th>抽查<br>結果</th><th>備註<br>(抽查人員)</th></tr>`;
      const photos = [], mark = self ? '☆' : '★';
      Q.stagesOf(t).forEach(stg => {
        const items = t.items.filter(i => i.stage === stg.key); if (!items.length) return;
        items.forEach((it, n) => {
          const a = ans[it.no] || {};
          (a.photos || []).filter(isImg).forEach((u, k) => photos.push({ u, cap: `${it.name}${(a.photos || []).length > 1 ? `（${k + 1}）` : ''}` }));
          let info = '';
          if (self && it.type === 'linked' && it.linked) info += `${info ? '<br>' : ''}表${E(it.linked)}：${(r.linked || {})[it.linked] ? '已完成' : '未完成'}`;
          let note = a.note ? E(a.note) : '';
          if ((a.photos || []).length) note += `${note ? '<br>' : ''}<span class="mut">照片 ${(a.photos || []).length} 張（附後）</span>`;
          if (self && it.hold) { const hs = ((r.hold || {})[it.no] || {}).state; if (hs) note += `${note ? '<br>' : ''}<span class="mut">停留點：${E(Q.HOLD_TEXT[hs] || hs)}</span>`; }
          if (!self && r.focusNo === it.no) note += `${note ? '<br>' : ''}<span class="star">本次會驗項目</span>`;
          const sa = !self ? selfAns(it) : null;
          if (sa && sa.judge) note += `${note ? '<br>' : ''}<span class="mut">廠商自檢：${JS[sa.judge]}</span>`;
          const stgCell = n === 0 ? `<td class="stg" rowspan="${items.length}">${vt(stg.name)}</td>` : '';
          h += `<tr data-brk>${stgCell}<td>${it.hold ? `<span class="star">${mark}</span>` : ''}${E(it.name)}</td><td>${E(it.std || '').replace(/\n/g, '<br>')}</td><td>${info}</td><td class="j${a.judge === 'ng' ? ' ng' : ''}">${a.judge ? JS[a.judge] : ''}</td><td>${note}</td></tr>`;
        });
      });
      if (!self && r.calc) {
        const c = r.calc, v = x => `<u>　${E(x || '　　')}　</u>`, area = Number(c.length) && Number(c.depth) ? (Number(c.length) * Number(c.depth)).toFixed(2) : '';
        h += `<tr data-brk><td colspan="6" class="calc">單元厚度：${v(c.thickness)} m　　單元長度：${v(c.length)} m<br>計價深度：${v(c.depth)} m　　計價面積：${v(area)} m²</td></tr>`;
      }
      // 缺失複查結果：依本紀錄產生的缺失追蹤狀態帶入
      const dfs = d.defects.filter(x => x.refId === r.id), closed = dfs.filter(x => x.status === 'closed');
      const doneAll = dfs.length ? closed.length === dfs.length : (self && r.recovery === 'done'), openAny = dfs.length ? closed.length < dfs.length : (self && r.recovery === 'open');
      const lastClose = closed.sort((x, y) => (y.closedAt || 0) - (x.closedAt || 0))[0], by = lastClose ? String(lastClose.note || '').replace(/\s*複查合格$/, '') : '';
      const ids = dfs.filter(x => x.status !== 'closed').map(x => x.id).join('、');
      h += `<tr data-brk><td colspan="6" class="rv"><div>缺失複查結果：</div>
        <div>${box(doneAll)}已完成改善（${self ? '檢具' : '檢附'}改善前中後照片）</div>
        <div>${box(openAny)}未完成改善，填具${self ? `「不合格管制總表」第 <u>　${E(ids || '　　')}　</u> 項` : '「缺點改進工作指示通知／回報單」'}進行追蹤改善</div>
        <div>複查日期：${lastClose ? E(Q.fmtD(lastClose.closedAt)) : '　　年　　月　　日'}</div>
        <div>複查人員職稱：${E(by)}　　　　${self ? '名簽' : '簽名'}：</div></td></tr>`;
      const notes = self ? ['檢查標準及檢查情形應具體明確（例：磚砌完成後須不透光）或量化尺寸（例：磚縫 7mm~10mm）。', '檢查結果合格者註明「○」，不合格者註明「╳」，如無需檢查之項目則打「╱」。', '嚴重缺失、缺失複查未能改善，應填具「不合格品管制總表」進行追蹤改善，本表單可先行存檔。', '本表由工地現場工程師或領班實地檢查後覈實記載簽認。']
        : ['★為檢驗停留點。', '抽查結果合格者註明「○」，不合格者註明「╳」，如無需檢查之項目則打「╱」。', '抽查標準及實際抽查情形應依設計圖說、規範及實際檢查情形，具體敘述檢查情形。', '嚴重缺失、缺失複查未能及時完成改善者，應填具「缺點改進工作指示通知／回報單」進行追蹤改善，本表單可先行存檔。', '本表由監造工務所現場人員實地抽查後覈實記載簽認。', '施工廠商施工自主檢查表將於檢查完成後，作為本抽查記錄表之附件存檔。'];
      h += `<tr data-brk><td colspan="6" class="rv"><div>備註：</div>${notes.map((x, i) => `<div class="ni">${i + 1}. ${x}</div>`).join('')}</td></tr></table>`;
      // 簽認（表格下方）
      const who = self ? [['rep', '工地授權代表<br>或其授權主管'], ['site', '現場工程師<br>（檢查人員）']] : [['att', '施工廠商隨同人員'], ['insp', '監造工務所']];
      h += `<table class="sg" data-brk><tr>${who.map(([k, l]) => { const g = sig[k] || {}; return `<td class="sl">${l}：</td><td class="sv">${isImg(g.img) ? `<img src="${g.img}">` : ''}<div>${E(g.name || '')}</div>${g.at ? `<div class="mut">${E(Q.fmtFull(g.at))}</div>` : ''}</td>`; }).join('')}</tr></table>`;
      if (self) h += `<div class="mut" data-brk>註：檢查人員簽核並加註檢查日期及時間。</div>`;
      h += `<div class="meta" data-brk>紀錄編號 ${E(r.id)}・表單版本 v${E(r.templateVer)}${self && r.drawingNo ? `・施工圖核准文號 ${E(r.drawingNo)}` : ''}・${r.status === 'signed' ? '已簽認' : '填寫中（草稿）'}${r.hash ? `・內容雜湊 ${E(r.hash)}` : ''}・${E(Q.fmtFull(Date.now()))} 由捷運施工查驗系統產生</div>`;
      if (photos.length) {
        h += `<div class="ttl" data-brk>附件：照片紀錄（${photos.length} 張）</div>`;
        for (let i = 0; i < photos.length; i += 4) h += `<div data-brk>${photos.slice(i, i + 4).map(p => `<div class="ph"><img src="${p.u}"><div style="width:150px">${E(p.cap)}</div></div>`).join('')}</div>`;
      }
      return h;
    }
    const recCode = r => (tplOf(r.templateId) || {}).code || r.templateCode || '';
    const recFile = (kind, r) => FormPDF.safeName(`${kind === 'self' ? '自主檢查' : '抽查'}_${r.tenderCode || ''}_${recCode(r)}${r.unit ? '_' + r.unit : ''}_${r.id}.pdf`);
    // 單筆 PDF：空白範本 PDF 填寫且已上傳 → 直接用簽名後的 PDF；其餘依表單版面產生
    async function recPdf(kind, r) {
      if (r.fillMode === 'pdf' && r.pdfFile && r.pdfFile.data) return new Blob([FormPDF.dataUrlToBytes(r.pdfFile.data)], { type: 'application/pdf' });
      return (await FormPDF.render(formHtml(kind, r))).blob;
    }
    // 查詢統計：自主檢查紀錄／抽查紀錄的查詢條件（標號 → 工項 → 單元，上層變更時清除下層）
    const swText = r => { const s = d.subworks.find(x => x.id === r.subworkId); return s ? `${s.no}、${s.name}` : (r.subworkName || '—'); };
    const projOf = r => Q.projKey(tenderById(r.tenderId));
    const projOpts = computed(() => Q.projOptions(d.tenders));
    const projText = k => (projOpts.value.find(x => x.v === k) || {}).l || k || '—';
    const tendersOfProj = k => d.tenders.filter(t => !k || Q.projKey(t) === k);
    const qf = reactive({ self: { proj: '', tender: '', sw: '', unit: '' }, spot: { proj: '', tender: '', sw: '', unit: '' } });
    const QF_LV = ['proj', 'tender', 'sw', 'unit'];
    const qfSrc = kind => kind === 'self' ? d.selfChecks : d.spotChecks;
    const qfPass = (f, r, upto) => { const n = upto === 'all' ? 9 : QF_LV.indexOf(upto);
      return (n <= 0 || !f.proj || projOf(r) === f.proj) && (n <= 1 || !f.tender || r.tenderId === f.tender) && (n <= 2 || !f.sw || r.subworkId === f.sw) && (n <= 3 || !f.unit || (f.unit === '__none__' ? !r.unit : r.unit === f.unit)); };
    function qfOptsOf(kind) {
      const f = qf[kind], L = qfSrc(kind), swOrder = id => (d.subworks.find(s => s.id === id) || {}).order ?? 99;
      const sws = [...new Map(L.filter(r => qfPass(f, r, 'sw') && r.subworkId).map(r => [r.subworkId, swText(r)]))].map(([v, l]) => ({ v, l })).sort((a, b) => swOrder(a.v) - swOrder(b.v));
      const L3 = L.filter(r => qfPass(f, r, 'unit')), units = [...new Set(L3.filter(r => r.unit).map(r => r.unit))].sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true })).map(v => ({ v, l: v }));
      if (units.length && L3.some(r => !r.unit)) units.push({ v: '__none__', l: '（無單元）' });
      if (f.sw && !sws.some(x => x.v === f.sw)) f.sw = ''; if (f.unit && !units.some(x => x.v === f.unit)) f.unit = '';
      return { sws, units };
    }
    const qfOpts = computed(() => ({ self: qfOptsOf('self'), spot: qfOptsOf('spot') }));
    const qfList = computed(() => ({ self: d.selfChecks.filter(r => qfPass(qf.self, r, 'all')), spot: d.spotChecks.filter(r => qfPass(qf.spot, r, 'all')) }));
    function qfSet(kind, lv, v) { const f = qf[kind]; f[lv] = v; QF_LV.slice(QF_LV.indexOf(lv) + 1).forEach(k => { f[k] = ''; }); }
    function qfClear(kind) { QF_LV.forEach(k => { qf[kind][k] = ''; }); }
    const ex = reactive({ proj: '', tender: '', sw: '', unit: '', kind: '', tpl: '', status: '', busy: '' });
    const EX_LV = ['proj', 'tender', 'sw', 'unit', 'kind', 'tpl', 'status'];
    const exRows = computed(() => d.selfChecks.map(r => ({ kind: 'self', r })).concat(d.spotChecks.map(r => ({ kind: 'spot', r })))
      .map(x => Object.assign(x, { key: x.kind + ':' + recCode(x.r), date: x.r.date || x.r.createdAt || 0 })).sort((a, b) => b.date - a.date));
    const exPass = (x, upto) => { const n = upto === 'all' ? 99 : EX_LV.indexOf(upto), r = x.r;
      return (n <= 0 || !ex.proj || projOf(r) === ex.proj) && (n <= 1 || !ex.tender || r.tenderId === ex.tender) && (n <= 2 || !ex.sw || r.subworkId === ex.sw) && (n <= 3 || !ex.unit || (ex.unit === '__none__' ? !r.unit : r.unit === ex.unit))
        && (n <= 4 || !ex.kind || x.kind === ex.kind) && (n <= 5 || !ex.tpl || x.key === ex.tpl) && (n <= 6 || !ex.status || (ex.status === 'signed' ? r.status === 'signed' : r.status !== 'signed')); };
    const exOpts = computed(() => {
      const L = exRows.value, uq = (arr, f) => { const m = new Map(); arr.forEach(x => { const [k, l] = f(x); if (k && !m.has(k)) m.set(k, l); }); return [...m].map(([v, l]) => ({ v, l })); };
      const swOrder = id => (d.subworks.find(s => s.id === id) || {}).order ?? 99;
      const sws = uq(L.filter(x => exPass(x, 'sw')), x => { const s = d.subworks.find(y => y.id === x.r.subworkId); return [x.r.subworkId, s ? `${s.no}、${s.name}` : x.r.subworkName]; }).sort((a, b) => swOrder(a.v) - swOrder(b.v));
      const L3 = L.filter(x => exPass(x, 'unit')), units = uq(L3.filter(x => x.r.unit), x => [x.r.unit, x.r.unit]).sort((a, b) => a.v.localeCompare(b.v, 'zh-Hant', { numeric: true }));
      if (units.length && L3.some(x => !x.r.unit)) units.push({ v: '__none__', l: '（無單元）' });
      const tpls = uq(L.filter(x => exPass(x, 'tpl')), x => [x.key, x.kind === 'self' ? `表${recCode(x.r)} ${x.r.templateName}` : `${x.r.templateName}（${recCode(x.r)}）`]).sort((a, b) => a.v.localeCompare(b.v, 'zh-Hant', { numeric: true }));
      const o = { sws, units, tpls };
      if (ex.sw && !sws.some(x => x.v === ex.sw)) ex.sw = ''; if (ex.unit && !units.some(x => x.v === ex.unit)) ex.unit = ''; if (ex.tpl && !tpls.some(x => x.v === ex.tpl)) ex.tpl = '';
      return o;
    });
    const exList = computed(() => exRows.value.filter(x => exPass(x, 'all')));
    function exSet(lv, v) { ex[lv] = v; EX_LV.slice(EX_LV.indexOf(lv) + 1).filter(k => k !== 'status').forEach(k => { ex[k] = ''; }); }
    function exClear() { EX_LV.forEach(k => { ex[k] = ''; }); }
    async function downloadRec(kind, r) {
      try { toast('產生 PDF 中…'); FormPDF.save(await recPdf(kind, r), recFile(kind, r)); toast('已下載 ' + recFile(kind, r)); }
      catch (e) { console.error(e); toast('PDF 產生失敗：' + e.message, true); }
    }
    async function downloadBatch() {
      const list = exList.value; if (!list.length) return toast('沒有符合條件的表單', true); if (ex.busy) return;
      const zip = new JSZip(), stamp = new Date(), pad = n => String(n).padStart(2, '0');
      const idx = [['類別', '紀錄編號', '區段標／單一標', '標號', '分項工程', '單元', '表號', '表單名稱', '版本', '日期', '填寫方式', '狀態', '檔案']];
      try {
        for (let i = 0; i < list.length; i++) {
          const { kind, r } = list[i]; ex.busy = `${i + 1} / ${list.length}`;
          const folder = kind === 'self' ? '自主檢查表/' : '抽查紀錄表/', name = recFile(kind, r);
          zip.file(folder + name, await recPdf(kind, r));
          idx.push([kind === 'self' ? '自主檢查表' : '抽查紀錄表', r.id, projOf(r), r.tenderCode || '', r.subworkName || '', r.unit || '', recCode(r), r.templateName, 'v' + r.templateVer, Q.fmtD(r.date || r.createdAt), r.fillMode === 'pdf' ? '空白範本 PDF' : '線上表單', r.status === 'signed' ? '已簽認' : '填寫中', folder + name]);
        }
        ex.busy = '壓縮中…';
        const ws = XLSX.utils.aoa_to_sheet(idx); ws['!cols'] = [12, 22, 12, 8, 22, 8, 8, 30, 6, 11, 12, 8, 50].map(w => ({ wch: w }));
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '下載清單'); zip.file('下載清單.xlsx', XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
        const blob = await zip.generateAsync({ type: 'blob' });
        FormPDF.save(blob, `表單批次下載_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.zip`);
        toast(`已下載 ${list.length} 筆表單（ZIP）`);
      } catch (e) { console.error(e); toast('批次下載失敗：' + e.message, true); }
      finally { ex.busy = ''; }
    }
    const navItems = [['g', '基本資料'], ['projects', '標案與分項工程'], ['templates', '表單範本'], ['docs', '參考文件'], ['g', '查驗作業'], ['holds', '停留點會驗', 'badge'], ['defects', '缺失追蹤', 'dbadge'], ['g', '查詢統計'], ['selfchecks', '自主檢查紀錄'], ['spots', '抽查紀錄'], ['export', '批次下載'], ['g', '系統'], ['users', '帳號與權限'], ['params', '參數設定']];
    // 側邊選單：分組可收合（狀態記在 localStorage）
    const navTree = (() => { const t = []; navItems.forEach(n => { if (n[0] === 'g') t.push({ group: n[1], items: [] }); else if (t.length) t[t.length - 1].items.push(n); else t.push({ link: n }); }); return t; })();
    const collapsed = reactive((() => { try { return JSON.parse(localStorage.getItem('qms3-nav-collapsed') || '{}'); } catch (e) { return {}; } })());
    function toggleGroup(name) { collapsed[name] = !collapsed[name]; try { localStorage.setItem('qms3-nav-collapsed', JSON.stringify(collapsed)); } catch (e) { /* ignore */ } }
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
      progTender, progFilter, progRows, progCount, holdTab, holdTabs, holdCount, holdList, holdByDate, selReqId, selReq, calView, sched, lockedAfter, hoursBefore, doSchedule, doReject, doStart, doCancel,
      showSC, showSP, itemsOf, judgeText, spotCount, defCls, defText, defTab, defList, defAct, defShow, defReview,
      selTenderId, selTender, treeGroups, tenderRefs, delTender, tDragId, tDragOver, tDragStart, tDragEnd, tDrop, grpOpen, grpIsOpen, treeOpen, swPick, treeAll, dept, deptName, setDept, allTenders, pick, pickData, pickSel, pickGroupAll, doPick, pickTender, pickSw, swSearch, swStatus, swPage, swPages, swPaged, swAll, swTplText, swHold, swForm, saveSw, moveSw, delSw, newTender, swImp, openSwImp, downloadSwSample, onSwFile, swImpOk, swImpBad, doSwImp,
      tplSw, tplUnit, tplUnits, unitForm, unitTplN, openUnitForm, addUnit, delUnit, swGroups, selTplId, tplTab, edit, previewOn, tplList, tplHistory, pickTpl, editUsed, editStages, isPdf, newTplForm, onNewPdf, onEditPdf, createTpl, pdfUrl, downloadFile, wfCls, readPdf, TYPES, holdN, addItem, delItem, moveItem, onType, saveEdit, delTpl, syncFromSelf, bulk, openBulk, onBulkFile, bulkOk, bulkView, doBulk, downloadBulkSample, exportSubwork, stageForm, stageItemN, openStageForm, stageAdd, stageMove, stageDel, stagePreset, applyStages, STAGE_PRESETS, newTpl, exportXlsx, dragId, dragOver, onDragStart, onDragEnd, onDrop, itemImp, openItemImp, onItemFile, itemImpForm, itemImpView, itemImpErrs, doItemImp,
      linkOpts, adminUser, swText, projOf, projOpts, projText, tendersOfProj, qf, qfOpts, qfList, qfSet, qfClear, ex, exOpts, exList, exRows, exSet, exClear, downloadRec, downloadBatch, recCode,
      docForm, userForm, docProj, docList, editProj, refDocs, saveDoc, newDoc, editDoc, onDocFile, saveUser, delRow, saveParams, resetDemo, navItems, navTree, collapsed, toggleGroup, titles, todayStr
    };
  }
}).mount('#app');
