/* 模擬「AI 分析 PDF」：以 pdf.js 取出文字與座標，依表格欄位（序／檢查項目／檢查標準／實際檢查情形／判定）還原檢查項目。
 * 雛型沒有真正的 AI 後端：這裡用版面規則解析，並以「分析中」進度呈現；結果可在預覽中逐項修改後才匯入。
 * 僅支援含文字層的 PDF（掃描檔／影像 PDF 無法辨識）。 */
(function () {
  let loading = null;
  const loadScript = src => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('無法載入 PDF 解析元件')); document.head.appendChild(s); });
  // 按需載入 pdf.js（主程式與 worker 都用 <script> 載入，讓它在主執行緒內解析，不受 file:// 限制）
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    if (!loading) loading = loadScript('lib/pdf.min.js?v=3.11.174').then(() => loadScript('lib/pdf.worker.min.js?v=3.11.174')).catch(e => { loading = null; throw e; });
    return loading;
  }
  const CJK = /[　-鿿＀-￯]/;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 把同一欄位的零碎文字片段接起來：中文直接相連，英數之間補空白
  function joinFrags(frags) {
    let out = '', prev = null;
    frags.forEach(f => {
      const s = f.s; if (!s) return;
      if (prev && out && !CJK.test(out.slice(-1)) && !CJK.test(s[0]) && !/\s$/.test(out) && !/^\s/.test(s) && f.x - (prev.x + prev.w) > 1.2) out += ' ';
      out += s; prev = f;
    });
    return out.replace(/\s+/g, ' ').trim();
  }
  const clean = s => String(s || '').replace(/\s+/g, '');

  async function readLines(data) {
    const pdf = await window.pdfjsLib.getDocument({ data }).promise, pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const pg = await pdf.getPage(n), tc = await pg.getTextContent();
      const its = tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0 })).sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = []; its.forEach(i => { const l = lines.find(l => Math.abs(l.y - i.y) <= 3); if (l) l.items.push(i); else lines.push({ y: i.y, items: [i] }); });
      lines.forEach(l => l.items.sort((a, b) => a.x - b.x)); lines.sort((a, b) => b.y - a.y);
      pages.push(lines);
    }
    return pages;
  }

  // 解析：回傳 { kind, code, name, items:[{stage,name,std,hold}], warnings:[], pages }
  async function parse(data) {
    const pages = await readLines(data), all = pages.flat();
    if (clean(all.map(l => l.items.map(i => i.s).join('')).join('')).length < 20) throw new Error('此 PDF 沒有可辨識的文字（可能是掃描檔或影像 PDF），AI 無法分析；請改用 Excel 匯入，或手動建立表單範本。');
    const text = l => l.items.map(i => i.s).join('');
    const warnings = [];
    // 標題：第一頁最上方的一行；表號：「表單編號：表 5-7」或「表單編號：SP-7」
    const first = pages[0] || [], title = clean(first[0] ? text(first[0]) : '');
    const codeLine = first.map(l => clean(text(l))).find(t => /表單編號/.test(t)) || '', cm = codeLine.match(/表單編號[:：]?表?([A-Za-z]*[A-Za-z0-9\-]*\d[A-Za-z0-9\-]*)/);
    const code = cm ? cm[1] : '';
    if (!code) warnings.push('未找到「表單編號」，請手動填寫表號。');
    const headTxt = all.map(l => clean(text(l))).find(l => /(檢查|抽查)項目/.test(l) && /標準/.test(l + 'x')) || '';
    const kind = /抽查/.test(title) || /抽查項目/.test(headTxt) ? 'spot' : 'self';
    if (!title) warnings.push('未找到表單名稱，請手動填寫。');

    const items = []; let cols = null, cur = null, stop = false;
    const classify = x => cols ? (x < cols[0] ? 0 : x < cols[1] ? 1 : x < cols[2] ? 2 : x < cols[3] ? 3 : 4) : 1;
    const pushCur = () => { if (cur) { items.push({ no: cur.no, name: joinFrags(cur.c[1]), std: joinFrags(cur.c[2]), act: joinFrags(cur.c[3]) }); cur = null; } };
    pages.forEach(lines => {
      // 本頁表頭：含「檢查項目／抽查項目」那一行，取各欄標題的 x 座標當欄位邊界
      const hi = lines.findIndex(l => /(檢查|抽查)項目/.test(clean(text(l))));
      if (hi >= 0) {
        const hl = lines[hi].items, find = re => { for (let k = 0; k < hl.length; k++) { let acc = ''; for (let m = k; m < hl.length && acc.length < 8; m++) { acc += hl[m].s.trim(); if (re.test(acc)) return hl[k]; } } return null; };
        const hSerial = hl[0], hStd = find(/^設計|^規範|標準/), hAct = find(/^實際/), hJudge = find(/^判定|^檢查結果|^抽查結果|^結果/);
        if (hStd && hAct) cols = [hSerial.x + Math.max(hSerial.w, 10) + 6, hStd.x - 12, hAct.x - 12, hJudge ? hJudge.x - 12 : 1e6];
        pushCur(); stop = false; lines = lines.slice(hi + 1);
      }
      if (!cols) return;
      for (const l of lines) {
        if (stop) break; const t = clean(text(l));
        if (/^備註|^註[:：]|現場工程師|工地授權代表|隨同人員|監造工務所/.test(t)) { pushCur(); stop = true; break; }
        const cells = [[], [], [], [], []]; l.items.forEach(i => cells[classify(i.x)].push(i));
        const sn = cells[0].map(i => i.s.trim()).join('');
        if (/^\d{1,3}[.、]?$/.test(sn)) { pushCur(); cur = { no: Number(sn.replace(/\D/g, '')), c: [[], [], [], [], []] }; }
        if (!cur) continue;
        for (let k = 1; k <= 3; k++) cells[k].forEach(i => cur.c[k].push(i));
      }
    });
    pushCur();
    const out = items.filter(i => i.name).map(i => {
      const hold = /^[☆★]/.test(i.name) || /[☆★]停留點/.test(i.name); const name = i.name.replace(/^[☆★]\s*/, '');
      return { stage: 'during', name, std: i.std, hold };
    });
    if (!out.length) warnings.push('找不到檢查項目表格，請確認 PDF 版面含「檢查項目／檢查標準」欄位。');
    else if (out.some(i => !i.std)) warnings.push(`有 ${out.filter(i => !i.std).length} 項沒有辨識到檢查標準，請在預覽中補上。`);
    return { kind, code, name: title.replace(/_?空白範本$/, ''), items: out, warnings, pages: pages.length };
  }

  // 模擬 AI 分析：依序顯示進度，至少約 2 秒；onStep(文字) 更新進度
  async function analyze(file, onStep) {
    const step = async (t, ms) => { onStep && onStep(t); await sleep(ms); };
    await step('讀取 PDF 檔案…', 350); await loadPdfJs();
    const buf = new Uint8Array(await file.arrayBuffer());
    await step('AI 辨識表單版面與表格欄位…', 600); const res = await parse(buf);
    await step(`AI 擷取檢查項目與檢查標準…（${res.items.length} 項）`, 600); await step('整理匯入預覽…', 300);
    return res;
  }
  window.PdfImport = { analyze, parse, loadPdfJs };
})();
