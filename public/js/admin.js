(function () {
  'use strict';
  // Whole-row links in tables
  document.querySelectorAll('tr[data-href]').forEach(function (tr) {
    tr.addEventListener('click', function (e) { if (e.target.closest('a,button,input,select,label,form')) return; location.href = tr.dataset.href; });
  });
  // Confirm destructive actions
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!confirm(f.dataset.confirm)) e.preventDefault(); });
  });
  // Mobile menu
  var side = document.getElementById('side'), btn = document.querySelector('.tab-menu');
  if (side && btn) {
    var set = function (o) { side.dataset.open = o; btn.setAttribute('aria-expanded', o); };
    btn.addEventListener('click', function () { set(side.dataset.open !== 'true'); });
    document.addEventListener('click', function (e) { if (side.dataset.open === 'true' && !side.contains(e.target) && !btn.contains(e.target)) set(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  }
  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      navigator.clipboard.writeText(b.dataset.copy).then(function () { var t = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1500); });
    });
  });
  // "/" focuses booking search
  var lk = document.getElementById('lk');
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && lk && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); lk.focus(); }
  });
})();
