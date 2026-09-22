(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---- Mobile menu ----
  var mb = $('.menu-btn'), drawer = $('#drawer');
  if (mb && drawer) {
    var setOpen = function (open) {
      drawer.setAttribute('data-open', open);
      mb.setAttribute('aria-expanded', open);
      mb.setAttribute('aria-label', open ? mb.dataset.closeLabel : mb.dataset.openLabel);
      $('.i-open', mb).hidden = open; $('.i-close', mb).hidden = !open;
      document.body.style.overflow = open ? 'hidden' : '';
    };
    mb.addEventListener('click', function () { setOpen(drawer.getAttribute('data-open') !== 'true'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawer.getAttribute('data-open') === 'true') { setOpen(false); mb.focus(); } });
  }

  function money(n, sym, lang) {
    var s = n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
    return sym + (lang === 'tr' ? s.replace('.', ',') : s);
  }
  function fill(str, v) { return str.replace(/\{(\w+)\}/g, function (m, k) { return v[k] != null ? v[k] : m; }); }

  // Local pricing (same maths as /js/pricing.js; duplicated here so the homepage needn't load it)
  function quote(t, bags, days, addons, tiers) {
    if (window.LPPricing) return window.LPPricing.quote(t, bags, days, addons, tiers);
    bags = Math.max(1, Math.min(bags, t.max_bags || 20));
    if (t.mode === 'per_bag_day') days = Math.max(t.min_days, Math.min(days, t.max_days));
    else if (t.mode === 'flat') days = Math.max(30, Math.min(Math.ceil(days / 30) * 30, 360)); else days = 1;
    var sub = t.mode === 'flat' ? t.price * days / 30 : t.mode === 'per_bag_day' ? t.price * bags * days : t.price * bags;
    var bd = t.mode === 'flat' ? 0 : t.mode === 'per_bag_day' ? bags * days : bags, pct = 0;
    tiers.forEach(function (x) { if (bd >= x.min_bag_days && x.percent > pct) pct = x.percent; });
    var disc = Math.round(sub * pct) / 100;
    return { bags: bags, days: days, bagDays: bd, percent: pct, subtotal: sub, discount: disc, addonsTotal: 0, total: Math.round((sub - disc) * 100) / 100 };
  }

  // Steppers (hero tag + booking form)
  function bindSteppers(root, onChange) {
    $$('[data-step]', root).forEach(function (b) {
      b.addEventListener('click', function () {
        var inp = root.querySelector('input[name="' + b.dataset.step + '"]');
        var v = (parseInt(inp.value, 10) || 0) + parseInt(b.dataset.d, 10);
        inp.value = Math.max(parseInt(inp.min || '1', 10), Math.min(v, parseInt(inp.max || '999', 10)));
        onChange();
      });
    });
  }

  // ---- Hero luggage-tag quote ----
  var q = $('#quote');
  if (q) {
    var tariffs = JSON.parse(q.dataset.tariffs), tiers = JSON.parse(q.dataset.tiers), sym = q.dataset.sym, lang = q.dataset.lang;
    var daysF = $('[data-days-field]', q), daysL = $('#days-l', q), note = $('#q-note'), tot = $('#q-total');
    var bagsI = q.elements.bags, daysI = q.elements.days;
    bagsI.min = 1; bagsI.max = 20; daysI.min = 1; daysI.max = 30;
    var calc = function () {
      var t = tariffs.filter(function (x) { return x.code === q.elements.plan.value; })[0];
      if (!t) return;
      var multi = t.mode !== 'per_bag';
      daysF.style.visibility = multi ? 'visible' : 'hidden';
      daysL.textContent = t.mode === 'flat' ? q.dataset.lMonths : q.dataset.lDays;
      if (t.mode === 'per_bag_day' && +daysI.value < t.min_days) daysI.value = t.min_days;
      if (t.mode === 'flat') bagsI.max = t.max_bags; else bagsI.max = 20;
      if (+bagsI.value > +bagsI.max) bagsI.value = bagsI.max;
      var days = t.mode === 'flat' ? (+daysI.value) * 30 : +daysI.value;
      var r = quote(t, +bagsI.value, days, [], tiers);
      tot.textContent = money(r.total, sym, lang);
      note.classList.toggle('good', r.percent > 0);
      if (r.percent > 0) note.textContent = fill(q.dataset.save, { pct: r.percent });
      else if (t.mode !== 'flat') {
        var nx = tiers.filter(function (x) { return x.min_bag_days > r.bagDays; })[0];
        note.textContent = nx ? fill(q.dataset.nudge, { n: nx.min_bag_days - r.bagDays, pct: nx.percent }) : q.dataset.fee;
      } else note.textContent = q.dataset.fee;
    };
    q.addEventListener('change', calc);
    bindSteppers(q, calc);
    q.addEventListener('submit', function () {
      var t = tariffs.filter(function (x) { return x.code === q.elements.plan.value; })[0];
      if (t && t.mode === 'flat') daysI.value = (+daysI.value) * 30;
      if (t && t.mode === 'per_bag') daysI.disabled = true;
    });
    calc();
  }

  // ---- Booking form live summary ----
  var f = $('#bookform');
  if (f) {
    var T = JSON.parse(f.dataset.tariffs), A = JSON.parse(f.dataset.addons), TI = JSON.parse(f.dataset.tiers), S = f.dataset.sym, LG = f.dataset.lang;
    var dField = $('[data-days-field]', f), dLabel = $('#b-days', f);
    var fmt = function (d) {
      try { return new Intl.DateTimeFormat(LG === 'tr' ? 'tr-TR' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(d); }
      catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
    };
    var sel = function () { var r = f.querySelector('input[name=tariff_id]:checked'); return r ? T.filter(function (x) { return x.id === +r.value; })[0] : T[0]; };
    var monthsMode = false;
    var calcB = function () {
      var t = sel(); if (!t) return;
      var isFlat = t.mode === 'flat';
      dField.style.display = t.mode === 'per_bag' ? 'none' : '';
      dLabel.textContent = isFlat ? f.dataset.lMonths : f.dataset.lDays;
      var dI = f.elements.days, bI = f.elements.bags;
      if (isFlat && !monthsMode) { dI.value = Math.max(1, Math.round((+dI.value || 30) / 30)); dI.max = 12; }
      if (!isFlat && monthsMode) { dI.value = t.min_days; dI.max = t.max_days; }
      monthsMode = isFlat;
      if (!isFlat) { dI.min = t.min_days; dI.max = t.max_days; if (+dI.value < t.min_days) dI.value = t.min_days; }
      bI.max = t.max_bags; if (+bI.value > t.max_bags) bI.value = t.max_bags; if (+bI.value < 1) bI.value = 1;
      var picked = $$('input[name=addons]:checked', f).map(function (c) { return A.filter(function (a) { return a.id === +c.value; })[0]; }).filter(Boolean);
      var days = isFlat ? (+dI.value) * 30 : +dI.value;
      var r = quote(t, +bI.value, days, picked, TI);
      $('#s-plan').textContent = t.name + ' × ' + r.bags;
      $('#s-sub').textContent = money(r.subtotal, S, LG);
      $('#s-disc-row').hidden = !r.discount; $('#s-disc').textContent = '−' + money(r.discount, S, LG); $('#s-pct').textContent = '(' + r.percent + '%)';
      $('#s-add-row').hidden = !r.addonsTotal; $('#s-add').textContent = money(r.addonsTotal, S, LG);
      $('#s-total').textContent = money(r.total, S, LG);
      var dt = f.elements.date.value, tm = f.elements.time.value;
      if (dt && tm) {
        var d = new Date(dt + 'T' + tm + ':00Z');
        d.setUTCHours(d.getUTCHours() + (t.mode === 'per_bag' ? t.hours : r.days * 24));
        $('#s-pick').textContent = fmt(d);
      }
    };
    f.addEventListener('change', calcB); f.addEventListener('input', calcB);
    bindSteppers(f, calcB);
    f.addEventListener('submit', function () {
      var t = sel();
      if (t && t.mode === 'flat') { f.elements.days.max = 360; f.elements.days.value = (+f.elements.days.value) * 30; }
    });
    calcB();
  }

  // ---- Misc ----
  $$('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });
  $$('form[data-confirm]').forEach(function (fm) { fm.addEventListener('submit', function (e) { if (!confirm(fm.dataset.confirm)) e.preventDefault(); }); });
})();
