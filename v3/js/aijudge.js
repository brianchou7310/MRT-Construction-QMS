// 模擬 AI 判定：依「檢查標準」比對「實際檢查／抽查情形」，回傳建議判定與理由
// 雛型沒有真的呼叫 AI 服務；這裡用規則比對數值與關鍵字，並加上延遲模擬等待回應
(function (g) {
  const num = s => { const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/); if (m) return +m[1] / +m[2]; const n = String(s).match(/-?\d+(?:\.\d+)?/); return n ? +n[0] : null; };
  const show = v => Number.isInteger(v) ? String(v) : v < 0.1 ? '1/' + Math.round(1 / v) : String(+v.toFixed(3));
  const lines = s => String(s || '').split(/\n/).map(x => x.trim()).filter(Boolean);
  const strip = s => s.replace(/^[□☐\s]*\d+\s*[.、)]\s*/, '').replace(/^[□☐]\s*/, '');
  // 一行標準 → 規則 { min, max, eq } 或 { word } 或 null（無法自動判定）
  function rule(line, all) {
    let s = strip(line);
    if (/設計|施工圖|EL\s*[：:=]?\s*m?$/.test(s) && !/[≦≤≧≥<>±]/.test(s)) return null;
    const vars = {}; all.replace(/([A-Za-z]+)\s*=\s*(\d+(?:\.\d+)?)/g, (_, k, v) => { vars[k] = +v; });
    const val = t => { t = t.trim(); const m = t.match(/^([A-Za-z]+)\s*(?:\+\s*(\d+(?:\.\d+)?))?/); if (m && vars[m[1]] != null) return vars[m[1]] + (+m[2] || 0); return num(t); };
    let m = s.match(/(.+?)[≦≤]\s*實測值\s*[≦≤](.+)/); if (m) { const a = val(m[1]), b = val(m[2]); if (a != null && b != null) return { min: a, max: b }; }
    m = s.match(/(\d+(?:\.\d+)?)\s*[a-zA-Z]*\s*±\s*(\d+(?:\.\d+)?)/); if (m) return { min: +m[1] - +m[2], max: +m[1] + +m[2] };
    if (/設計/.test(s)) return null;
    m = s.match(/(?:[≦≤<]|不得超過|不大於|不得大於)\s*=?\s*([\d./]+)/); if (m) return { max: num(m[1]) };
    m = s.match(/(?:[≧≥>]|不低於|不小於|不得小於)\s*=?\s*([\d./]+)/); if (m) return { min: num(m[1]) };
    m = s.match(/([\d.]+)\s*[a-zA-Z]*\s*以下/); if (m) return { max: +m[1] };
    m = s.match(/([\d.]+)\s*[a-zA-Z]*\s*以上/); if (m) return { min: +m[1] };
    m = s.match(/偏差\s*[：:]?\s*([\d.]+)/) || (/其他方向/.test(s) && s.match(/[：:]\s*([\d.]+)/)); if (m) return { max: +m[1] };
    m = s.match(/@\s*([\d.]+)/); if (m) return { eq: +m[1], at: true };
    if (/^無|無雜物|無隆起|不得有/.test(s)) return { word: 'none' };
    if (/覆蓋|護欄|清除|清理|完成|安裝|設置|正常/.test(s)) return { word: 'done' };
    return null;
  }
  const label = s => strip(s).split(/[：:≦≤≧≥<>±@\d]/)[0].replace(/[\s□]/g, '');
  function check(r, t, name) {
    if (!t || !t.trim()) return { j: 'unknown', msg: `${name}：未填寫` };
    if (r.word) {
      if (/有\s*[\/／]\s*無|已\s*[\/／]\s*未|是\s*[\/／]\s*否/.test(t)) return { j: 'unknown', msg: `${name}：尚未圈選結果` };
      const neg = /未|不符|不合格|不正常|異常|破損|缺/.test(t), has = /有/.test(t) && !/沒有/.test(t), none = /無|沒有/.test(t);
      if (r.word === 'none') return has && !none ? { j: 'ng', msg: `${name}：填寫為「有」，不符標準` } : none ? { j: 'ok', msg: `${name}：符合標準` } : { j: 'unknown', msg: `${name}：無法辨識填寫內容` };
      if (neg || (none && !has)) return { j: 'ng', msg: `${name}：填寫內容顯示未完成或不符標準` };
      return /已|有|完成|正常|是/.test(t) ? { j: 'ok', msg: `${name}：符合標準` } : { j: 'unknown', msg: `${name}：無法辨識填寫內容` };
    }
    const body = strip(t), after = body.includes(':') || body.includes('：') ? body.split(/[：:]/).slice(1).join(':') : body;
    const v = r.at ? (m => m ? +m[1] : null)(after.match(/@\s*([\d.]+)/) || body.match(/@\s*([\d.]+)/)) : num(after.replace(/[A-Za-z]*\d*\s*@/, ''));
    if (v == null) return { j: 'unknown', msg: `${name}：未填寫數值` };
    if (r.eq != null) return v === r.eq ? { j: 'ok', msg: `${name}：${show(v)}，符合標準 ${show(r.eq)}` } : { j: 'ng', msg: `${name}：${show(v)}，與標準 ${show(r.eq)} 不符` };
    if (r.min != null && v < r.min) return { j: 'ng', msg: `${name}：${show(v)}，低於下限 ${show(r.min)}` };
    if (r.max != null && v > r.max) return { j: 'ng', msg: `${name}：${show(v)}，超過上限 ${show(r.max)}` };
    return { j: 'ok', msg: `${name}：${show(v)}，在標準範圍內` };
  }
  function evaluate(std, text, itemName) {
    const sl = lines(std).filter(l => !/^\(?[A-Za-z]+\s*=\s*[\d.]+[a-zA-Z]*\)?$/.test(l)), tl = lines(text), out = [];
    if (!tl.length) return { judge: 'unknown', reasons: ['尚未填寫內容'] };
    sl.forEach((l, i) => {
      const name = sl.length > 1 ? (label(l) || `第 ${i + 1} 點`) : itemName, r = rule(l, String(std));
      if (!r) return out.push({ j: 'unknown', msg: `${name}：標準無明確數值或需對照設計圖說，請人工判定` });
      const lb = label(l), t = sl.length === 1 ? tl.join(' ') : (tl.length === sl.length ? tl[i] : tl.find(x => lb && x.replace(/\s/g, '').includes(lb.slice(0, 2)))) || '';
      out.push(check(r, t, name));
    });
    if (!out.length) return { judge: 'unknown', reasons: ['此項未設定檢查標準，請人工判定'] };
    const judge = out.some(o => o.j === 'ng') ? 'ng' : out.every(o => o.j === 'ok') ? 'ok' : out.some(o => o.j === 'ok') ? 'partial' : 'unknown';
    return { judge, reasons: out.map(o => (o.j === 'ok' ? '○ ' : o.j === 'ng' ? '╳ ' : '？ ') + o.msg) };
  }
  // 模擬呼叫：0.9～1.6 秒後回覆
  const judge = (std, text, itemName) => new Promise(res => setTimeout(() => res(evaluate(std, text, itemName || '填寫內容')), 900 + Math.random() * 700));
  g.AIJudge = { judge, evaluate, LABEL: { ok: '合格', ng: '有缺失', partial: '部分需人工確認', unknown: '無法判定' } };
})(window);
