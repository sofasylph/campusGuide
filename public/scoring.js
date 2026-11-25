// Shared by the browser and the server so scores are always calculated one way.
(function (root) {
  function score(d, ans) {
    if (!d.items || !d.items.length || !ans || ans.length !== d.items.length) return null;
    var v = [];
    for (var i = 0; i < ans.length; i++) {
      var vs = d.items[i].v || d.v, a = ans[i];
      if (!Number.isInteger(a) || a < 0 || a >= vs.length) return null; // a missing answer is never scored as zero
      var x = vs[a];
      if (d.items[i].rev) x = Math.min.apply(null, vs) + Math.max.apply(null, vs) - x; // reverse-scored item
      v.push(x);
    }
    var raw = v.reduce(function (p, q) { return p + q; }, 0);
    var s = d.method === 'mean' ? Math.round(raw / v.length * 100) / 100 : d.method === 'sum4' ? raw * 4 : raw;
    var subs = (d.subs || []).map(function (b) { return { name: b.name, score: b.items.reduce(function (t, k) { return t + v[k]; }, 0), atLeast: b.atLeast }; });
    return { score: s, raw: raw, subs: subs };
  }
  function band(d, r) {
    if (!d.bands || !d.bands.length) return null;
    var x = d.bandOn === 'raw' ? r.raw : r.score, b = null;
    d.bands.forEach(function (c) { if (b === null && x >= c.lo && x <= c.hi) b = { flag: c.flag, label: c.label, descriptive: !!c.descriptive }; });
    if (b && b.flag === 'green' && r.subs.some(function (u) { return u.atLeast != null && u.score >= u.atLeast; })) b = { flag: 'yellow', label: 'A subscale is at or above the screening level', descriptive: false };
    return b;
  }
  root.Scoring = { score: score, band: band };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Scoring;
})(typeof window !== 'undefined' ? window : this);
