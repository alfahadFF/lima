/* bookmarklet.src.js — زر السحب (يعمل داخل صفحة شي إن / تيمو)
 * لا يحتاج أي خادم ولا مفاتيح. يقرأ البيانات التي في متصفحك أنت (جلسة حقيقية)
 * ثم ينسخها JSON جاهزًا للصق في لوحة التحكم.
 * يُبنى إلى رابط javascript: داخل import.html
 */
(function () {
  var SRC = /(^|\.)shein\./i.test(location.hostname) ? 'shein'
    : /(^|\.)temu\.com$/i.test(location.hostname) ? 'temu'
    : /aliexpress/i.test(location.hostname) ? 'aliexpress' : 'other';

  var IMG = /\.(jpe?g|png|webp|avif)(\?|$)/i;
  var HOST = /(ltwebstatic|shein|temu|kwcdn|kwimgs|alicdn|aecdn|img\.)/i;

  function txt(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function cleanImg(u) {
    if (!u) return null;
    u = String(u).trim().replace(/^\/\//, 'https://').replace(/^http:/i, 'https:');
    if (!/^https?:/i.test(u)) return null;
    return u.replace(/_thumbnail_\d+x\d+(?:_crop)?/i, '');
  }

  function meta(p) {
    var el = document.querySelector('meta[property="' + p + '"]') || document.querySelector('meta[name="' + p + '"]');
    return el ? el.getAttribute('content') : '';
  }

  // JSON-LD داخل الصفحة
  var ld = null;
  document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
    if (ld) return;
    try {
      var j = JSON.parse(s.textContent);
      var find = function (n) {
        if (!n || typeof n !== 'object') return null;
        if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { var r = find(n[i]); if (r) return r; } return null; }
        var t = n['@type'];
        if (t === 'Product' || (t && t.indexOf && t.indexOf('Product') > -1)) return n;
        if (n['@graph']) return find(n['@graph']);
        return null;
      };
      ld = find(j);
    } catch (e) {}
  });

  // البحث في حالة الصفحة المدمجة (شي إن: gbRawData، تيمو: rawData)
  var state = null;
  try { state = window.gbRawData || window.rawData || window.__INITIAL_STATE__ || window.__NEXT_DATA__ || null; } catch (e) {}

  var found = { titles: [], prices: [], images: [], colors: [], sizes: [], soldOut: [] };
  function walk(n, d) {
    if (!n || typeof n !== 'object' || d > 14 || (window.__blCount = (window.__blCount || 0) + 1) > 25000) return;
    if (!Array.isArray(n)) {
      for (var k in n) {
        if (!Object.prototype.hasOwnProperty.call(n, k)) continue;
        var v = n[k], lk = k.toLowerCase();
        if (typeof v === 'string') {
          if (/^(goods_name|goodsname|productname|product_name|title|name|subject)$/.test(lk) && v.length > 8 && v.length < 400) found.titles.push(v);
          if (/^(currency|currencycode|pricecurrency)$/.test(lk) && /^[a-z]{3}$/i.test(v)) found.currencies = [v.toUpperCase()];
          if (/(image|img|gallery|picture|thumb|photo)/.test(lk) && /^https?:|^\/\//.test(v)) found.images.push(v);
          if (/^(colour_name|color_name|color|colour)$/.test(lk) && v.length < 40) found.colors.push(v);
          if (/^(size|size_name)$/.test(lk) && v.length < 20) found.sizes.push(v);
        } else if (typeof v === 'number') {
          if (/(saleprice|sale_price|nowprice|currentprice|minprice|price|amount)$/.test(lk) && v > 0 && v < 100000) found.prices.push({ v: v, w: /(sale|now|current|min)/.test(lk) ? 2 : 1 });
        } else if (v && typeof v === 'object') {
          if (Array.isArray(v) && /(image|gallery|picture)/.test(lk)) v.forEach(function (x) { if (typeof x === 'string') found.images.push(x); else if (x && x.url) found.images.push(x.url); });
          walk(v, d + 1);
        }
      }
    } else {
      for (var i = 0; i < n.length && i < 300; i++) if (n[i] && typeof n[i] === 'object') walk(n[i], d + 1);
    }
  }
  try { walk(state, 0); } catch (e) {}

  // العنوان
  var title = (ld && ld.name) || found.titles.sort(function (a, b) { return b.length - a.length; })[0] || meta('og:title') || document.title;
  title = txt(title).replace(/\s*[|\-–]\s*(SHEIN|Temu|AliExpress)\s*$/i, '').slice(0, 300);

  // السعر
  var price = ld && ld.offers ? parseFloat(ld.offers.price || (ld.offers[0] && ld.offers[0].price)) : null;
  if (!(price > 0)) {
    found.prices.sort(function (a, b) { return b.w - a.w; });
    price = found.prices.length ? found.prices[0].v : null;
  }
  if (!(price > 0)) {
    var m = txt((document.body.innerText || '').slice(0, 3000)).match(/(?:\$|US\$|USD)\s?(\d+(?:\.\d{1,2})?)/);
    if (m) price = parseFloat(m[1]);
  }
  if (!(price > 0)) price = parseFloat(meta('product:price:amount')) || null;

  // الصور
  var imgs = [];
  if (ld && ld.image) imgs = imgs.concat([].concat(ld.image).map(function (x) { return typeof x === 'string' ? x : x && x.url; }));
  imgs.push(meta('og:image'));
  imgs = imgs.concat(found.images);
  document.querySelectorAll('img').forEach(function (im) {
    if (imgs.length > 30) return;
    var s = im.currentSrc || im.src || im.getAttribute('data-src') || '';
    if (/(ltwebstatic|kwcdn|alicdn|aecdn)/i.test(s) && (im.naturalWidth || im.width) > 150) imgs.push(s);
  });
  var seen = {}, images = [];
  imgs.forEach(function (u) {
    u = cleanImg(u);
    if (!u || !IMG.test(u.split('?')[0]) || !HOST.test(u)) return;
    var k = u.split('?')[0].toLowerCase();
    if (seen[k]) return;
    seen[k] = 1; images.push(u);
  });

  var uniq = function (a) {
    var s = {}, o = [];
    a.forEach(function (x) { var t = txt(x); if (!t || t.length > 40) return; var k = t.toLowerCase(); if (s[k]) return; s[k] = 1; o.push(t); });
    return o.slice(0, 25);
  };

  var data = {
    title: title,
    source_url: location.origin + location.pathname,
    source: SRC,
    price: price,
    currency: (ld && ld.offers && (ld.offers.priceCurrency || (ld.offers[0] && ld.offers[0].priceCurrency))) || (found.currencies && found.currencies[0]) || meta('product:price:currency') || 'USD',
    description: txt((ld && ld.description) || meta('og:description') || meta('description') || '').slice(0, 1200),
    images: images.slice(0, 12),
    colors: uniq(found.colors),
    sizes: uniq(found.sizes),
    soldOut: []
  };

  var json = JSON.stringify(data, null, 1);
  try { navigator.clipboard.writeText(json); } catch (e) {}

  // لوحة داخل الصفحة (حتى لو فشل النسخ)
  var old = document.getElementById('__lym_panel'); if (old) old.remove();
  var box = document.createElement('div');
  box.id = '__lym_panel';
  box.setAttribute('style', 'position:fixed;inset:12px;z-index:2147483647;background:#fffdfb;color:#3a2620;border:1px solid #b38a3e;border-radius:16px;padding:14px;font:15px/1.6 system-ui;direction:rtl;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:auto');
  box.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">' +
    '<b>تم سحب البيانات ' + (data.title ? '✓' : '⚠') + '</b>' +
    '<button id="__lym_x" style="border:0;background:#eee;border-radius:8px;padding:4px 10px;cursor:pointer">إغلاق</button></div>' +
    '<div style="font-size:13px;color:#7b6258;margin-bottom:8px">' +
    'العنوان: ' + (data.title || '—') + '<br>السعر: ' + (data.price != null ? data.price + ' ' + data.currency : '—') +
    '<br>الصور: ' + data.images.length + ' · الألوان: ' + data.colors.length + ' · المقاسات: ' + data.sizes.length + '</div>' +
    '<div style="font-size:13px;margin-bottom:8px">' + (data.title && data.images.length ? 'تم النسخ تلقائيًا — الصقه في لوحة التحكم بـ «لصق JSON».' : 'البيانات ناقصة — راجع الحقول بعد اللصق.') + '</div>' +
    '<textarea id="__lym_t" style="width:100%;height:150px;font:12px/1.4 monospace;direction:ltr;border:1px solid #ebd9ce;border-radius:10px;padding:8px">' + json.replace(/</g, '&lt;') + '</textarea>' +
    '<div style="display:flex;gap:8px;margin-top:8px"><button id="__lym_c" style="flex:1;border:0;background:#3a2620;color:#fff;border-radius:10px;padding:10px;cursor:pointer">نسخ مرة أخرى</button></div>' +
    '<div id="__lym_ok" style="font-size:12px;color:#157a4a;margin-top:6px"></div>';
  document.body.appendChild(box);
  box.querySelector('#__lym_x').onclick = function () { box.remove(); };
  box.querySelector('#__lym_c').onclick = function () {
    var t = box.querySelector('#__lym_t'); t.select();
    try { document.execCommand('copy'); box.querySelector('#__lym_ok').textContent = 'تم النسخ ✓'; } catch (e) {}
  };
  box.querySelector('#__lym_t').onclick = function () { this.select(); };
})();
