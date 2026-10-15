/* 表單版面 PDF：把表單內容排成紙本版面（HTML）→ html2canvas 轉圖 → 依表格列切成 A4 分頁 → jsPDF 輸出
   中文直接用瀏覽器字型繪製，不需另外內嵌字型；分頁只在 [data-brk] 元素（表格列、區塊）之間切開，不會切到一半。 */
(function () {
  const A4W = 794, A4H = 1123, M = 36;            // A4 @96dpi，左右上下邊界（px）
  const BODY_H = A4H - M * 2 - 22;                // 每頁可用高度（扣頁尾頁碼）
  const SCALE = 2;                                 // 解析度倍率
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const CSS = `
    .fp{width:${A4W - M * 2}px;font-family:"Microsoft JhengHei","PingFang TC","Noto Sans TC","Noto Sans CJK TC",sans-serif;color:#111;font-size:11.5px;line-height:1.45;background:#fff}
    .fp h1{font-size:18px;margin:0 0 2px;text-align:center;letter-spacing:1px}
    .fp .sub{text-align:center;color:#444;margin-bottom:8px;font-size:12px}
    .fp table{width:100%;border-collapse:collapse;table-layout:fixed}
    .fp td,.fp th{border:1px solid #333;padding:4px 5px;vertical-align:top;word-break:break-all}
    .fp th{background:#e8eef1;font-weight:700;text-align:center}
    .fp .fp-kv td.k{background:#f3f6f8;font-weight:700;white-space:nowrap}
    .fp .stage td{background:#dfe9ee;font-weight:700}
    .fp .c{text-align:center}.fp .j{text-align:center;font-size:15px;font-weight:700}
    .fp .ng{color:#c62828}.fp .star{color:#c77800}.fp .mut{color:#555;font-size:10.5px}
    .fp .blk{margin-top:10px}.fp .ttl{font-weight:700;margin:10px 0 4px;font-size:12.5px}
    .fp .sig{height:64px;text-align:center}.fp .sig img{max-height:60px;max-width:100%}
    .fp .ph{display:inline-block;margin:0 6px 6px 0;text-align:center;font-size:10px;color:#555;vertical-align:top}
    .fp .ph img{width:150px;height:112px;object-fit:cover;border:1px solid #999;display:block}
    .fp .note{font-size:10.5px;color:#333;margin:0;padding-left:18px}
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

  function save(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function dataUrlToBytes(u) { const b = atob(String(u).split(',')[1] || ''); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();

  window.FormPDF = { render, save, esc, dataUrlToBytes, safeName };
})();
