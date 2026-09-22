/* LuggagePark pricing engine — shared by server and browser.
   The server always recalculates; the browser copy only shows a live quote. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LPPricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function round2(n) { return Math.round(n * 100) / 100; }

  /**
   * @param {object} tariff {mode, price, min_days, max_days, max_bags}
   * @param {number} bags
   * @param {number} days
   * @param {Array} addons [{price, per}] selected add-ons
   * @param {Array} tiers  [{min_bag_days, percent}]
   */
  function quote(tariff, bags, days, addons, tiers) {
    bags = Math.max(1, Math.min(parseInt(bags, 10) || 1, tariff.max_bags || 50));
    days = parseInt(days, 10) || 1;
    if (tariff.mode === 'per_bag_day') days = Math.max(tariff.min_days || 1, Math.min(days, tariff.max_days || 60));
    else if (tariff.mode === 'flat') days = Math.max(30, Math.min(Math.ceil(days / 30) * 30, 360));
    else days = 1;

    var subtotal, bagDays;
    if (tariff.mode === 'flat') { subtotal = tariff.price * (days / 30); bagDays = 0; }
    else if (tariff.mode === 'per_bag_day') { subtotal = tariff.price * bags * days; bagDays = bags * days; }
    else { subtotal = tariff.price * bags; bagDays = bags; }

    var pct = 0;
    (tiers || []).forEach(function (t) { if (bagDays >= t.min_bag_days && t.percent > pct) pct = t.percent; });
    var discount = round2(subtotal * pct / 100);

    var addonsTotal = 0;
    (addons || []).forEach(function (a) { addonsTotal += a.per === 'bag' ? a.price * bags : a.price; });

    subtotal = round2(subtotal); addonsTotal = round2(addonsTotal);
    return {
      bags: bags, days: days, bagDays: bagDays, percent: pct,
      subtotal: subtotal, discount: discount, addonsTotal: addonsTotal,
      total: round2(subtotal - discount + addonsTotal)
    };
  }

  function nextTier(bagDays, tiers) {
    var t = (tiers || []).slice().sort(function (a, b) { return a.min_bag_days - b.min_bag_days; })
      .find(function (x) { return x.min_bag_days > bagDays; });
    return t || null;
  }

  return { quote: quote, nextTier: nextTier, round2: round2 };
});
