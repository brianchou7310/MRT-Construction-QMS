/* 表單版面 PDF：把表單內容排成紙本版面（HTML）→ html2canvas 轉圖 → 依表格列切成 A4 分頁 → jsPDF 輸出
   中文直接用瀏覽器字型繪製，不需另外內嵌字型；分頁只在 [data-brk] 元素（表格列、區塊）之間切開，不會切到一半。 */
(function () {
  const A4W = 794, A4H = 1123, M = 36;            // A4 @96dpi，左右上下邊界（px）
  const BODY_H = A4H - M * 2 - 22;                // 每頁可用高度（扣頁尾頁碼）
  const SCALE = 2;                                 // 解析度倍率
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const CSS = `
    .fp{width:${A4W - M * 2}px;font-family:"DFKai-SB","BiauKai","標楷體","Microsoft JhengHei","PingFang TC","Noto Sans TC","Noto Sans CJK TC",sans-serif;color:#000;font-size:12px;line-height:1.5;background:#fff}
    .fp .t1{text-align:center;font-size:16px;margin-bottom:4px}
    .fp .t2{text-align:center;font-size:20px;font-weight:700;letter-spacing:4px;margin-bottom:2px}
    .fp .t3{text-align:center;font-size:14px;margin-bottom:6px}.fp .t3.b{font-size:17px;font-weight:700}
    .fp table{width:100%;border-collapse:collapse;table-layout:fixed}
    .fp td,.fp th{border:1px solid #000;padding:3px 5px;vertical-align:middle;word-break:break-all}
    .fp th{font-weight:400;text-align:center;line-height:1.35}
    .fp .hd td.k{text-align:left;white-space:nowrap;padding:3px 6px}
    .fp .it{margin-top:-1px}
    .fp .stg{text-align:center;line-height:1.4}
    .fp .j{text-align:center;font-size:15px;font-weight:700}
    .fp .calc{font-size:13px;line-height:1.9;padding:4px 8px}
    .fp .rv{line-height:1.7;padding:4px 6px;vertical-align:top}.fp .rv .ni{padding-left:1.4em;text-indent:-1.4em}
    .fp .sg{margin-top:6px}.fp .sg td{border:none;vertical-align:top;padding:2px 4px}
    .fp .sg .sl{width:18%;text-align:right;white-space:nowrap}.fp .sg .sv{width:32%;min-height:48px}
    .fp .sg img{max-height:44px;max-width:100%;display:block}
    .fp .ng{color:#c62828}.fp .star{color:#000}.fp .mut{color:#555;font-size:10.5px}
    .fp .meta{margin-top:6px;color:#666;font-size:9.5px}
    .fp .blk{margin-top:10px}.fp .ttl{font-weight:700;margin:12px 0 4px;font-size:13px}
    .fp .ph{display:inline-block;margin:0 6px 6px 0;text-align:center;font-size:10px;color:#555;vertical-align:top}
    .fp .ph img{width:150px;height:112px;object-fit:cover;border:1px solid #999;display:block}
  `;


  async function render(html) {
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-20000px;top:0;width:${A4W - M * 2}px;background:#fff;z-index:-1`;
    host.innerHTML = `<style>${CSS}</style><div class="fp">${html}</div>`;
    document.body.appendChild(host);
    try {
      const imgs = [...host.querySelectorAll('img')];
      await Promise.all(imgs.map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; })));
      const root = host.querySelector('.fp'), top0 = root.getBoundingClientRect().top;
      // 可切頁的位置：每個 [data-brk] 的下緣
      const total = Math.ceil(root.getBoundingClientRect().height);
      const cuts = [...root.querySelectorAll('[data-brk]')].map(e => Math.round(e.getBoundingClientRect().bottom - top0)).filter(y => y > 0 && y < total).sort((a, b) => a - b);
      const pages = []; let y0 = 0;
      while (y0 < total - 1) {
        const lim = y0 + BODY_H; if (lim >= total) { pages.push([y0, total]); break; }
        const c = cuts.filter(y => y > y0 + 40 && y <= lim).pop(); const y1 = c || lim; pages.push([y0, y1]); y0 = y1;
      }
      const canvas = await html2canvas(root, { scale: SCALE, backgroundColor: '#ffffff', logging: false, useCORS: true });
      const { jsPDF } = window.jspdf, pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
      const PW = pdf.internal.pageSize.getWidth(), PH = pdf.internal.pageSize.getHeight(), k = PW / A4W;
      pages.forEach(([a, b], i) => {
        const pc = document.createElement('canvas'); pc.width = A4W * SCALE; pc.height = A4H * SCALE;
        const g = pc.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, pc.width, pc.height);
        g.drawImage(canvas, 0, a * SCALE, canvas.width, (b - a) * SCALE, M * SCALE, M * SCALE, canvas.width, (b - a) * SCALE);
        g.fillStyle = '#666'; g.font = `${11 * SCALE}px "Microsoft JhengHei","Noto Sans TC",sans-serif`; g.textAlign = 'center';
        g.fillText(`第 ${i + 1} 頁／共 ${pages.length} 頁`, (A4W / 2) * SCALE, (A4H - M + 6) * SCALE);
        if (i) pdf.addPage();
        pdf.addImage(pc.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, PW, PH);
      });
      return { blob: pdf.output('blob'), pages: pages.length, k };
    } finally { host.remove(); }
  }

  // 表單版面（後台 PDF 下載與現場列印共用）。ctx = { d, tplOf }：d 需含 tenders、subworks、defects
  function formHtml(kind, r, ctx) {
      const Q = window.QMS, d = ctx.d, tplOf = ctx.tplOf, FormPDF = { esc };
      const isImg = u => typeof u === 'string' && /^data:image\//.test(u);
      const JS = { ok: '○', ng: '╳', na: '╱' };
      const calcOf = x => ((tplOf(x.templateId) || {}).calcFields || []).filter(c => (c.label || '').trim());
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
      const cols = [5, 18, 26, 25, 8, 18];
      h += `<table class="it"><colgroup>${cols.map(w => `<col style="width:${w}%">`).join('')}</colgroup>`;
      h += self ? `<tr data-brk><th colspan="2">檢查項目</th><th>設計圖說、規範之檢查標準<br>(定量定性)</th><th>實際檢查情形<br>(敘述檢查值)</th><th>檢查<br>結果</th><th>備註<br>(檢查人員)</th></tr>`
                : `<tr data-brk><th colspan="2">抽查項目</th><th>設計圖說、規範之<br>抽查標準（定性定量）</th><th>實際抽查情形<br>（敘述抽查情形）</th><th>抽查<br>結果</th><th>備註<br>(抽查人員)</th></tr>`;
      const photos = [], mark = self ? '☆' : '★';
      Q.stagesOf(t).forEach(stg => {
        const items = t.items.filter(i => i.stage === stg.key); if (!items.length) return;
        items.forEach((it, n) => {
          const a = ans[it.no] || {};
          const tag = (l, k) => `${it.name}${l.length > 1 ? `（${k + 1}）` : ''}`;
          (a.photos || []).filter(isImg).forEach((u, k, l) => photos.push({ u, cap: tag(l, k) }));
          let info = a.text ? E(a.text).replace(/\n/g, '<br>') : '';
          if (self && it.type === 'linked' && it.linked) info += `${info ? '<br>' : ''}表${E(it.linked)}：${(r.linked || {})[it.linked] ? '已完成' : '未完成'}`;
          // 備註欄只放該項檢查人員／抽查人員的簽名與簽名日期時間
          const note = a.sig && isImg(a.sig.img) ? `<img src="${a.sig.img}" style="height:32px;max-width:100%;display:block;margin:0 auto">${a.sig.at ? `<div style="text-align:center;font-size:9px;white-space:nowrap">${E(Q.fmtFull(a.sig.at))}</div>` : ''}` : '';
          const stgCell = n === 0 ? `<td class="stg" rowspan="${items.length}">${vt(stg.name)}</td>` : '';
          h += `<tr data-brk>${stgCell}<td>${it.hold ? `<span class="star">${mark}</span>` : ''}${E(it.name)}</td><td>${E(it.std || '').replace(/\n/g, '<br>')}</td><td>${info}</td><td class="j${a.judge === 'ng' ? ' ng' : ''}">${a.judge ? JS[a.judge] : ''}</td><td>${note}</td></tr>`;
        });
      });
      // 計價欄位：範本有定義才顯示
      const cfs = self ? [] : calcOf(r);
      if (cfs.length) { const c = r.calc || {}, v = x => `<u>　${E(x || '　　')}　</u>`;
        h += `<tr data-brk><td colspan="6" class="calc">${cfs.map((f, i) => `${E(f.label)}：${v(c[f.key])} ${E(f.unit || '')}${i % 2 && i < cfs.length - 1 ? '<br>' : '　　'}`).join('')}</td></tr>`; }
      // 缺失複查結果：依本紀錄產生的缺失追蹤狀態帶入
      const dfs = d.defects.filter(x => x.refId === r.id), closed = dfs.filter(x => x.status === 'closed');
      const doneAll = dfs.length ? closed.length === dfs.length : (self && r.recovery === 'done'), openAny = dfs.length ? closed.length < dfs.length : (self && r.recovery === 'open');
      const lastClose = closed.sort((x, y) => (y.closedAt || 0) - (x.closedAt || 0))[0], by = lastClose ? (lastClose.closedBy || String(lastClose.note || '').replace(/\s*複查合格$/, '')) : '';
      const rcSig = lastClose && lastClose.recheck ? lastClose.recheck.sig : null;
      const ids = dfs.filter(x => x.status !== 'closed').map(x => x.id).join('、');
      h += `<tr data-brk><td colspan="6" class="rv"><div>缺失複查結果：</div>
        <div>${box(doneAll)}已完成改善（${self ? '檢具' : '檢附'}改善前中後照片）</div>
        <div>${box(openAny)}未完成改善，填具${self ? `「不合格管制總表」第 <u>　${E(ids || '　　')}　</u> 項` : '「缺點改進工作指示通知／回報單」'}進行追蹤改善</div>
        <div>複查日期：${lastClose ? E(Q.fmtD(lastClose.closedAt)) : '　　年　　月　　日'}</div>
        <div>複查人員職稱：${E(by)}　　　　簽名：${rcSig && isImg(rcSig.img) ? `<img src="${rcSig.img}" style="height:34px;vertical-align:middle">` : ''}</div></td></tr>`;
      const notes = self ? ['檢查標準及檢查情形應具體明確（例：磚砌完成後須不透光）或量化尺寸（例：磚縫 7mm~10mm）。', '檢查結果合格者註明「○」，不合格者註明「╳」，如無需檢查之項目則打「╱」。', '嚴重缺失、缺失複查未能改善，應填具「不合格品管制總表」進行追蹤改善，本表單可先行存檔。', '本表由工地現場工程師或領班實地檢查後覈實記載簽認。']
        : ['★為檢驗停留點。', '抽查結果合格者註明「○」，不合格者註明「╳」，如無需檢查之項目則打「╱」。', '抽查標準及實際抽查情形應依設計圖說、規範及實際檢查情形，具體敘述檢查情形。', '嚴重缺失、缺失複查未能及時完成改善者，應填具「缺點改進工作指示通知／回報單」進行追蹤改善，本表單可先行存檔。', '本表由監造工務所現場人員實地抽查後覈實記載簽認。', '施工廠商施工自主檢查表將於檢查完成後，作為本抽查記錄表之附件存檔。'];
      h += `<tr data-brk><td colspan="6" class="rv"><div>備註：</div>${notes.map((x, i) => `<div class="ni">${i + 1}. ${x}</div>`).join('')}</td></tr></table>`;
      // 簽認（表格下方）
      const who = self ? [['rep', '工地授權代表<br>或其授權主管'], ['site', '現場工程師<br>（檢查人員）']] : [['att', '施工廠商隨同人員'], ['insp', '監造工務所']];
      h += `<table class="sg" data-brk><tr>${who.map(([k, l]) => { const g = sig[k] || {}; return `<td class="sl">${l}：</td><td class="sv">${isImg(g.img) ? `<img src="${g.img}">` : ''}<div>${E(g.name || '')}</div>${g.at ? `<div class="mut">${E(Q.fmtFull(g.at))}</div>` : ''}</td>`; }).join('')}</tr></table>`;
      if (self) h += `<div class="mut" data-brk>註：檢查人員簽核並加註檢查日期及時間。</div>`;
      h += `<div class="meta" data-brk>紀錄編號 ${E(r.id)}・表單版本 v${E(r.templateVer)}${self && r.drawingNo ? `・施工圖核准文號 ${E(r.drawingNo)}` : ''}・${r.status === 'signed' ? '已簽認' : '填寫中（草稿）'}${r.hash ? `・內容雜湊 ${E(r.hash)}` : ''}・${E(Q.fmtFull(Date.now()))} 由捷運施工查驗系統產生</div>`;
      // 缺失改善與複查紀錄：改善內容（照片＋說明）與簽名、複查結果與簽名
      const fixed = dfs.filter(x => x.fix || x.recheck || x.lastFix);
      if (fixed.length) {
        const sg = (g, who) => g && isImg(g.img) ? `<div style="margin-top:4px;font-size:10px">${who}：<img src="${g.img}" style="height:30px;vertical-align:middle"> ${E(g.name || '')}　${g.at ? E(Q.fmtFull(g.at)) : ''}</div>` : '';
        const imgs = f => (f.items || (f.photos || []).map(u => ({ photo: u, desc: '' }))).map((it, k) => `<div style="display:inline-block;vertical-align:top;width:170px;margin:4px 8px 4px 0;font-size:10px">${isImg(it.photo) ? `<img src="${it.photo}" style="width:170px;height:120px;object-fit:cover;border:1px solid #cbd5e1">` : ''}<div>${k + 1}. ${E(it.desc || '')}</div></div>`).join('');
        h += `<div class="ttl" data-brk>附件：缺失改善與複查紀錄（${fixed.length} 筆缺失）</div>`;
        fixed.forEach(df => {
          const st = df.status === 'closed' ? '已結案' : df.status === 'review' ? '待複查' : '待改善', f = df.fix || df.lastFix;
          h += `<div data-brk style="margin:6px 0 10px;padding:6px 8px;border:1px solid #cbd5e1;font-size:11px"><div><b>缺失 ${E(df.id)}：${E(df.title)}</b>（${st}）</div>`;
          if (f) h += `<div style="margin-top:4px">缺失改善（${E(f.by || '')}・${f.at ? E(Q.fmtFull(f.at)) : ''}）${df.fix ? '' : '〔已退回，內容為上一次改善〕'}：</div><div>${imgs(f)}</div>${sg(f.sig, '改善人員簽名')}`;
          if (df.recheck) h += `<div style="margin-top:6px">缺失複查（${E(df.recheck.by || '')}・${E(Q.fmtFull(df.recheck.at))}）：<b>${df.recheck.pass ? '合格' : '不合格，退回改善'}</b>${df.recheck.note ? '　' + E(df.recheck.note) : ''}</div>${sg(df.recheck.sig, '複查人員簽名')}`;
          h += `</div>`;
        });
      }
      if (photos.length) {
        h += `<div class="ttl" data-brk>附件：照片紀錄（${photos.length} 張）</div>`;
        for (let i = 0; i < photos.length; i += 4) h += `<div data-brk>${photos.slice(i, i + 4).map(p => `<div class="ph"><img src="${p.u}"><div style="width:150px">${E(p.cap)}</div></div>`).join('')}</div>`;
      }
      return h;
    }

  // 單筆 PDF：空白範本 PDF 填寫且已上傳 → 直接用簽名後的 PDF；其餘依表單版面產生
  const recFile = (kind, r, ctx) => safeName(`${kind === 'self' ? '自主檢查' : '抽查'}_${r.tenderCode || ''}_${(ctx.tplOf(r.templateId) || {}).code || r.templateCode || ''}${r.unit ? '_' + r.unit : ''}_${r.id}.pdf`);
  async function recPdf(kind, r, ctx) {
    if (r.fillMode === 'pdf' && r.pdfFile && r.pdfFile.data) return new Blob([dataUrlToBytes(r.pdfFile.data)], { type: 'application/pdf' });
    return (await render(formHtml(kind, r, ctx))).blob;
  }

  function save(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function dataUrlToBytes(u) { const b = atob(String(u).split(',')[1] || ''); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();

  window.FormPDF = { render, save, esc, dataUrlToBytes, safeName, formHtml, recFile, recPdf };
})();
