/* 抽屜共用行為：點標題列右側 ✕ 關閉、按 Esc 關閉最上層抽屜 */
(function () {
  function closeTop() { var l = document.querySelectorAll('.modal-bg'); if (l.length) l[l.length - 1].click(); }
  document.addEventListener('click', function (e) {
    var t = e.target; if (!t.matches || !t.matches('.modal h3')) return;
    if (e.offsetX > t.clientWidth - 52) t.closest('.modal-bg').click();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeTop(); });
})();
