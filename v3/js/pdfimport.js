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

  // 取出表格線：PDF 的框線多半是很細的填色矩形（寬或高 < 1.5），回傳水平線 hs{y,x0,x1}、垂直線 vs{x,y0,y1}
  async function readRules(pg) {
    const OPS = window.pdfjsLib.OPS, ol = await pg.getOperatorList(), hs = [], vs = [], st = []; let ctm = [1, 0, 0, 1, 0, 0];
    const mul = (m, t) => [m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1], m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3], m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5]];
    ol.fnArray.forEach((f, i) => {
      const a = ol.argsArray[i];
      if (f === OPS.save) st.push(ctm.slice()); else if (f === OPS.restore) ctm = st.pop() || ctm; else if (f === OPS.transform) ctm = mul(ctm, a);
      else if (f === OPS.constructPath && a[0].length === 1 && a[0][0] === OPS.rectangle && [OPS.fill, OPS.eoFill, OPS.stroke].includes(ol.fnArray[i + 1])) {
        const [x, y, w, h] = a[1], X = ctm[0] * x + ctm[2] * y + ctm[4], Y = ctm[1] * x + ctm[3] * y + ctm[5], W = ctm[0] * w, H = ctm[3] * h;
        const x0 = Math.min(X, X + W), x1 = Math.max(X, X + W), y0 = Math.min(Y, Y + H), y1 = Math.max(Y, Y + H);
        if (y1 - y0 < 1.5 && x1 - x0 > 6) hs.push({ y: (y0 + y1) / 2, x0, x1 }); else if (x1 - x0 < 1.5 && y1 - y0 > 6) vs.push({ x: (x0 + x1) / 2, y0, y1 });
      }
    });
    return { hs, vs };
  }
  async function readLines(data) {
    const pdf = await window.pdfjsLib.getDocument({ data }).promise, pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const pg = await pdf.getPage(n), tc = await pg.getTextContent();
      const its = tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0 })).sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = []; its.forEach(i => { const l = lines.find(l => Math.abs(l.y - i.y) <= 3); if (l) l.items.push(i); else lines.push({ y: i.y, items: [i] }); });
      lines.forEach(l => l.items.sort((a, b) => a.x - b.x)); lines.sort((a, b) => b.y - a.y);
      lines.its = its; lines.rules = await readRules(pg).catch(() => ({ hs: [], vs: [] }));
      pages.push(lines);
    }
    return pages;
  }

  // ---- 依表格線解析（框線齊全的 PDF）：垂直線切欄、水平線切列，階段取最左欄的直排文字 ----
  const uniq = (arr, tol) => { const out = []; arr.slice().sort((a, b) => a - b).forEach(v => { if (!out.length || v - out[out.length - 1] > tol) out.push(v); }); return out; };
  const stageKey = t => /後|完成/.test(t) ? 'post' : /前/.test(t) ? 'pre' : 'during';
  function parseGrid(pages) {
    let cols = null, prevStage = 'during'; const items = [];
    const textOf = (its, sep, col) => {   // 同欄內依行（由上而下）、x 由左而右組字；行首是編號／項目符號時才換行
      const rows = []; its.slice().sort((a, b) => b.y - a.y || a.x - b.x).forEach(i => { const r = rows.find(r => Math.abs(r.y - i.y) <= 3); if (r) r.items.push(i); else rows.push({ y: i.y, items: [i] }); });
      for (let k = rows.length - 1; k >= 0; k--) {   // 單獨一行的個位數（m²、m³ 的上標）併回相鄰行
        const r = rows[k]; if (r.items.length > 2 || !r.items.every(i => /^\d$/.test(i.s.trim()))) continue;
        const host = rows.find((o, j) => j !== k && Math.abs(o.y - r.y) <= 7 && o.items.some(i => r.items.every(t => t.x >= i.x - 2 && t.x <= i.x + i.w + 8)));
        if (host) { host.items.push(...r.items); rows.splice(k, 1); }
      }
      rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
      // 換行規則：'\n' 每行都換；'auto' 上一行寫滿欄寬（自動折行）就接起來，否則換行；其餘一律接起來
      const ls = rows.map(r => ({ t: joinFrags(r.items), full: col ? Math.max(...r.items.map(i => i.x + i.w)) > col[1] - 20 : false }));
      return ls.reduce((acc, l, k) => { if (!k) return l.t; const brk = sep === '\n' || (sep === 'auto' && (!ls[k - 1].full || /^(\d+[.、)）]|[（(]\d+[)）]|[・•●□])/.test(l.t)));
        return brk ? acc + '\n' + l.t : acc + (!CJK.test(acc.slice(-1)) && !CJK.test(l.t[0]) ? ' ' : '') + l.t; }, '');
    };
    const spans = (h, x0, x1) => h.x0 <= x0 + 3 && h.x1 >= x1 - 3;
    for (const lines of pages) {
      const { hs, vs } = lines.rules || { hs: [], vs: [] }; if (!hs.length || !vs.length) continue;
      const hdr = lines.find(l => /^(檢查|抽查)項目/.test(clean(l.items.map(i => i.s).join(''))));   // 表頭列（不可與圖例「無此檢查項目」混淆）
      let bodyTop = 1e9;
      if (hdr && !cols) {
        const hItem = hdr.items[0], hy = hdr.y;
        const cover = hs.filter(h => h.x0 <= hItem.x && h.x1 >= hItem.x + 20), below = cover.filter(h => h.y < hy).map(h => h.y).sort((a, b) => b - a)[0];
        if (below == null) continue; bodyTop = below;
        const cx = uniq(vs.filter(v => v.y1 - v.y0 > 8 && v.y0 < bodyTop + 2 && v.y1 <= bodyTop + 2).map(v => v.x), 2.5);   // 表頭下方各列的垂直線
        const heads = lines.its.filter(i => i.y > bodyTop && i.y < hy + 40);
        const find = re => {   // 先找單一文字片段，再找緊鄰的單字（直排表頭，例如「標」「準」）
          const sorted = heads.slice().sort((a, b) => a.x - b.x), one = sorted.find(i => re.test(i.s.replace(/\s/g, ''))); if (one) return one;
          for (let k = 0; k < sorted.length; k++) { let acc = sorted[k].s.trim(); for (let m = k + 1; m < sorted.length && acc.length < 8 && Math.abs(sorted[m].y - sorted[k].y) < 3 && sorted[m].x - sorted[m - 1].x < 24; m++) { acc += sorted[m].s.trim(); if (re.test(acc)) return sorted[k]; } }
          return null; };
        const colAt = x => { for (let k = 0; k + 1 < cx.length; k++) if (x >= cx[k] - 1 && x <= cx[k + 1] + 1) return [cx[k], cx[k + 1]]; return null; };
        const hStd = find(/標準/), hAct = find(/實際/);
        const item = colAt(hItem.x + 3), std = hStd && colAt(hStd.x + 3), act = hAct && colAt(hAct.x + 3);
        if (!item || !std || !act) continue;
        const lc = cx.filter(x => x < item[0] - 2); cols = { item, std, act, stage: lc.length ? [lc[0], item[0]] : null };
      } else if (hdr && cols) {
        const hItem = hdr.items[0]; bodyTop = hs.filter(h => h.x0 <= hItem.x && h.x1 >= hItem.x + 20 && h.y < hdr.y).map(h => h.y).sort((a, b) => b - a)[0] ?? 1e9;
      }
      if (!cols) continue;
      const ix = cols.item, rowYs = uniq(hs.filter(h => spans(h, ix[0], ix[1])).map(h => h.y), 1.5).reverse();
      const vAt = (x, mid) => vs.some(v => Math.abs(v.x - x) < 2.5 && v.y0 <= mid && v.y1 >= mid);
      // 階段群組：水平線橫跨最左欄的區間；標籤取區間內的直排文字（沒有標籤＝上一頁階段延續）
      const groups = []; if (cols.stage) {
        const gy = uniq(hs.filter(h => spans(h, cols.stage[0], Math.min(cols.stage[1], cols.stage[0] + 20))).map(h => h.y), 1.5).reverse();
        for (let k = 0; k + 1 < gy.length; k++) { const g = { yt: gy[k], yb: gy[k + 1] }; g.label = clean(textOf(lines.its.filter(i => i.x >= cols.stage[0] - 1 && i.x < cols.stage[1] && i.y <= g.yt + 1 && i.y >= g.yb - 1), '\n').replace(/\n/g, '')); groups.push(g); }
      }
      for (let k = 0; k + 1 < rowYs.length; k++) {
        const yt = rowYs[k], yb = rowYs[k + 1], mid = (yt + yb) / 2; if (yt > bodyTop + 1.5 || yt - yb < 6) continue;
        if (!vAt(ix[1], mid)) continue;   // 橫跨全寬的列（缺失複查結果、備註、簽名）不是檢查項目
        const inRow = lines.its.filter(i => i.y <= yt + 1 && i.y >= yb - 1), cell = c => inRow.filter(i => i.x >= c[0] - 1 && i.x < c[1] - 0.5);
        const name = textOf(cell(cols.item), '').trim(), std = textOf(cell(cols.std), 'auto', cols.std).trim(), act = textOf(cell(cols.act), '\n', cols.act).trim();
        const g = groups.find(g => mid <= g.yt + 0.5 && mid >= g.yb - 0.5); if (g && g.label) prevStage = stageKey(g.label);
        if (name) items.push({ name, std, act, stage: prevStage });
      }
    }
    return items;
  }

  // 解析：回傳 { kind, code, name, items:[{stage,name,std,hold}], warnings:[], pages }
  async function parse(data) {
    const pages = await readLines(data), all = pages.flat();
    if (clean(all.map(l => l.items.map(i => i.s).join('')).join('')).length < 20) throw new Error('此 PDF 沒有可辨識的文字（可能是掃描檔或影像 PDF），AI 無法分析；請改用 Excel 匯入，或手動建立表單範本。');
    const text = l => l.items.map(i => i.s).join('');
    const warnings = [];
    // 標題：第一頁最上方的一行；表號：「表單編號：表 5-7」或「表單編號：SP-7」
    const first = pages[0] || [], tops = first.slice(0, 8).map(l => clean(text(l)));
    const title = tops.find(t => /表$/.test(t) && /(檢查|抽查|紀錄|記錄)/.test(t) && !/工程名稱|項目/.test(t)) || tops[0] || '';   // 標題不一定是第一行（第一行常是機關名稱）
    const codeLine = first.map(l => clean(text(l))).find(t => /表單編號/.test(t)) || '', cm = codeLine.match(/表單編號[:：]?表?([A-Za-z]*[A-Za-z0-9\-]*\d[A-Za-z0-9\-]*)/);
    let code = cm ? cm[1] : '', ttl = title; const tm = title.match(/^表?(\d+(?:-\d+)+|[A-Za-z]{1,4}-\d+)(.+)$/); if (!code && tm) { code = tm[1]; ttl = tm[2]; } else if (tm && tm[1] === code) ttl = tm[2];
    if (!code) warnings.push('未找到「表單編號」，請手動填寫表號。');
    const headTxt = all.map(l => clean(text(l))).find(l => /(檢查|抽查)項目/.test(l) && /標準/.test(l + 'x')) || '';
    const kind = /抽查/.test(ttl) || /抽查項目/.test(headTxt) ? 'spot' : 'self';
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
    const grid = parseGrid(pages);   // 有表格框線：以框線切欄切列（較準）；否則用文字位置
    const out = (grid.length ? grid : items.map(i => Object.assign(i, { stage: 'during' }))).filter(i => i.name).map(i => {
      const hold = /^[☆★]/.test(i.name) || /[☆★]停留點/.test(i.name); const name = i.name.replace(/^[☆★]\s*/, '');
      return { stage: i.stage, name, std: i.std, defText: i.act || '', hold };
    });
    if (!out.length) warnings.push('找不到檢查項目表格，請確認 PDF 版面含「檢查項目／檢查標準」欄位。');
    else if (out.some(i => !i.std)) warnings.push(`有 ${out.filter(i => !i.std).length} 項沒有辨識到檢查標準，請在預覽中補上。`);
    return { kind, code, name: ttl.replace(/_?空白範本$/, ''), items: out, warnings, pages: pages.length };
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
