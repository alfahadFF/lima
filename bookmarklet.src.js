/* bookmarklet.src.js — v2
 * أساسه الملف الذي أرسلته (نفس منطق الصور والـ JSON-LD و soldOut)
 * + إضافتان كانتا ناقصتين: المقاسات والألوان، بثلاث طبقات لكل منهما.
 *
 * يُشغَّل داخل صفحة المنتج (شي إن / تيمو) فيقرأ البيانات الحقيقية من الصفحة نفسها.
 * ينسخ JSON بالشكل الذي تفهمه لوحة التحكم، ويعرض لوحة للنسخ اليدوي إن فشل النسخ.
 */
(function () {
  var out = {
    source_url: location.origin + location.pathname,
    source: /(^|\.)shein\./i.test(location.hostname) ? 'shein'
      : /(^|\.)temu\.com$/i.test(location.hostname) ? 'temu'
      : /aliexpress/i.test(location.hostname) ? 'aliexpress' : 'other',
    title: '', description: '', price: null, currency: '', sku: '',
    images: [], sizes: [], soldOut: [], colors: [], otherColors: [],
    found: [], diag: {}
  };

  function add(a, v) { if (v != null && String(v).trim() && a.indexOf(String(v).trim()) < 0) a.push(String(v).trim()); }
  function abs(u) { if (!u) return ''; u = String(u).trim(); if (!u) return ''; try { return new URL(u, location.href).href; } catch (e) { return ''; } }
  function meta(p) {
    var m = document.querySelector('meta[property="' + p + '"],meta[name="' + p + '"]');
    return m ? (m.getAttribute('content') || '') : '';
  }
  function txt(e) { return ((e && e.textContent) || '').replace(/\s+/g, ' ').trim(); }
  function balancedJson(text, from) {
    var open = text[from];
    if (open !== '{' && open !== '[') return null;
    var close = open === '{' ? '}' : ']', depth = 0, inStr = false, esc = false;
    for (var i = from; i < text.length; i++) {
      var c = text.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (!depth) return text.slice(from, i + 1); }
    }
    return null;
  }

  function walk(n, cb, d) {
    d = d || 0;
    if (d > 16) return;
    if (Array.isArray(n)) { for (var i = 0; i < n.length && i < 400; i++) walk(n[i], cb, d + 1); }
    else if (n && typeof n === 'object') {
      cb(n);
      if (n['@graph']) walk(n['@graph'], cb, d + 1);
    }
  }

  /* كل نصوص السكربتات مرة واحدة (تُستخدم للصور والمقاسات والألوان) */
  var scriptText = [].map.call(document.scripts, function (s) { return s.textContent || ''; }).join('\n')
    .replace(/\\u002F/gi, '/').replace(/\\+\//g, '/');

  /* ---------- ١) بيانات المنتج من JSON-LD أو من كائن Product داخل السكربتات ---------- */
  function handleProduct(o) {
    var t = [].concat(o['@type'] || []);
    if (t.indexOf('Product') < 0) return;
    add(out.found, 'ld+json');
    out.title = out.title || o.name || '';
    out.description = out.description || o.description || '';
    out.sku = out.sku || o.sku || o.mpn || '';
    var of = [].concat(o.offers || [])[0];
    if (of) {
      out.price = out.price || parseFloat(of.price || of.lowPrice) || null;
      out.currency = out.currency || of.priceCurrency || '';
    }
    [].concat(o.hasVariant || []).forEach(function (v) {
      if (!v || typeof v !== 'object') return;
      var sz = v.size || (v.name && /^(xx?s|m|l|x{0,3}l|\d{2})$/i.test(String(v.name).trim()) ? String(v.name).trim() : null);
      if (sz) add(out.sizes, sz);
      if (v.color) add(out.colors, v.color);
      var av = v.availability || (v.offers && [].concat(v.offers)[0] && [].concat(v.offers)[0].availability) || '';
      if (/OutOfStock|SoldOut|Discontinued/i.test(String(av)) && sz) add(out.soldOut, sz);
    });
  }

  document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
    try { walk(JSON.parse(s.textContent), handleProduct); } catch (e) {}
  });

  // كائنات Product مدمجة داخل سكربتات عادية (ليست ld+json)
  (function () {
    var marker = '"@type":"Product"', from = 0, guard = 0;
    while (guard++ < 12) {
      var pos = scriptText.indexOf(marker, from);
      if (pos < 0) break;
      from = pos + marker.length;
      var st = scriptText.lastIndexOf('{', pos);
      if (st < 0) continue;
      var seg = balancedJson(scriptText, st);
      if (!seg) continue;
      try { handleProduct(JSON.parse(seg)); } catch (e) {
        try { handleProduct(JSON.parse(seg.replace(/\\"/g, '"'))); } catch (e2) {}
      }
      if (out.sizes.length && out.soldOut.length) break;
    }
  })();

  /* ---------- ٢) الصور (منطق ملفك الأصلي) ---------- */
  var seen = {}, gal = [];
  function base(u) {
    return u.replace(/^[a-z]+:/i, '').replace(/_thumbnail_[^.\/]*/, '').replace(/\.(avif|webp|jpe?g|png)(\?.*)?$/i, '');
  }
  function addImg(u) {
    u = abs(u);
    if (!u || !/(ltwebstatic|kwcdn|kwimgs|alicdn|aecdn)\.com\//i.test(u)) return;
    if (/\.(avif|webp|jpe?g|png)(\?|$)/i.test(u.replace(/_thumbnail_[^.\/]*/i, ''))) {
      u = u.replace(/_thumbnail_\d+x\d+(_crop)?/i, '').replace(/_thumbnail_[^.\/]*/i, '');
    }
    var b = base(u);
    if (seen[b]) return;
    seen[b] = 1;
    gal.push(u);
  }
  ['.main-picture img', '.product-intro__main-item img', '[class*="main-picture"] img',
   '[class*="gallery"] img', '[class*="swiper"] img', '[class*="carousel"] img'].forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (i) {
      (i.outerHTML.match(/(?:https?:)?\/\/[^\s"',)]+/g) || []).forEach(addImg);
      if (i.currentSrc) addImg(i.currentSrc);
      if (i.src) addImg(i.src);
    });
  });
  out.diag.imgsFromGallery = gal.length;

  // استكمال بقية صور نفس المنتج من نص السكربتات (مفتاح الصورة: المسار + معرّف المنتج)
  var keyRe = /\/pi\/(\d{4}\/\d{2}\/\d{2})\/[0-9a-f]{2}\/(\d{7})/i;
  var keys = gal.map(function (u) { var m = u.match(keyRe); return m ? m[1] + '|' + m[2] : null; }).filter(Boolean);
  (scriptText.match(/(?:https?:)?\/\/img\.ltwebstatic\.com\/v4\/j\/pi\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{2}\/[0-9a-f]{20,}[^"'\s\\,)]*/gi) || [])
    .forEach(function (u) {
      var m = u.match(keyRe);
      // إن لم نجد صورًا في المعرض أصلًا، نقبل ما في السكربت (كلها لنفس المنتج)
      if (!keys.length || (m && keys.indexOf(m[1] + '|' + m[2]) > -1)) addImg(u);
    });
  // صور تيمو
  (scriptText.match(/(?:https?:)?\/\/img\.kwcdn\.com\/[^"'\s\\,)]{10,}/gi) || []).slice(0, 20).forEach(addImg);

  out.diag.imgsTotal = gal.length;
  out.images = gal.slice(0, 12);
  if (!out.images.length) add(out.images, abs(meta('og:image')));

  /* ---------- ٣) المقاسات ---------- */
  // (أ) عناصر المقاسات في الصفحة
  var sizeSel = [
    '.goods-size__sizes-item',
    '[class*="goods-size__sizes-item"]',
    '.product-intro__size-radio',
    '[class*="size-radio"]',
    '[class*="size__item"]',
    '[class*="size-item"]',
    '[data-size]',
    '.sku-property-item[data-attr-name="size"]',
    '[class*="attr"][class*="size"] [role="radio"]'
  ];
  var sizeClasses = [];
  sizeSel.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (li) {
      var t = txt(li.querySelector('[class*="item-text"]') || li).replace(/\s+/g, ' ');
      if (!t || t.length > 24) return;
      // تجاهل حاويات المجموعات
      if (/size-group/.test(li.className)) return;
      var label = li.getAttribute('data-size') || t;
      if (!/^[a-z0-9/.\s+-]{1,20}$/i.test(label) && !/[\u0600-\u06FF]/.test(label)) return;
      add(out.sizes, label);
      if (sizeClasses.length < 8) add(sizeClasses, (li.className || '').toString().slice(0, 60));
      if (/sold|out|disable|unavail|not/i.test(li.className) || li.getAttribute('aria-disabled') === 'true') add(out.soldOut, label);
    });
  });
  out.diag.sizeClasses = sizeClasses;
  out.diag.sizesFromDom = out.sizes.length;

  // (ب) من سكيما المنتج داخل السكربتات
  if (!out.sizes.length) {
    var mk = scriptText.indexOf('goodsDetailSchema');
    out.diag.schemaMarker = mk > -1;
    if (mk > -1) {
      var seg = scriptText.slice(Math.max(0, mk - 60000), mk);
      var st = seg.lastIndexOf('@context');
      if (st > -1) seg = seg.slice(st);
      var re1 = /availability\\*"\s*:\s*\\*"[^"\\]*?schema\.org\/(\w+)\\*"\s*\}\s*,\s*\\*"size\\*"\s*:\s*\\*"([^"\\]+)/g, m1;
      while ((m1 = re1.exec(seg))) {
        add(out.sizes, m1[2]);
        if (/out|sold/i.test(m1[1])) add(out.soldOut, m1[2]);
      }
      if (!out.sizes.length) {
        var re2 = /\\*"size\\*"\s*:\s*\\*"([^"\\]+)/g, m2;
        while ((m2 = re2.exec(seg))) add(out.sizes, m2[1]);
      }
      if (out.sizes.length) add(out.found, 'schema-sizes');
    }
  }

  // (ج) من كائنات الحالة داخل الصفحة (gbRawData / rawData / sku_list …)
  if (!out.sizes.length) {
    var st2 = null;
    try { st2 = window.gbRawData || window.rawData || window.__INITIAL_STATE__ || window.__NEXT_DATA__ || null; } catch (e) {}
    if (st2) {
      walk(st2, function (o) {
        [].concat(o.sku_list || o.skuList || o.skus || o.variants || o.props || []).forEach(function (v) {
          if (!v || typeof v !== 'object') return;
          var s = v.size || v.size_name || v.sizeName || v.sizeValue;
          if (typeof s === 'string' && s.length < 20) add(out.sizes, s);
          var c = v.color || v.color_name || v.colorName || v.colour;
          if (typeof c === 'string' && c.length < 30) add(out.colors, c);
          var stock = v.stock == null ? v.inventory : v.stock;
          if (s && stock != null && Number(stock) <= 0) add(out.soldOut, s);
        });
      });
    }
    if (out.sizes.length) add(out.found, 'state-sizes');
  }

  // (د) من نص السكربتات: "size":"M"
  if (!out.sizes.length) {
    var re3 = /\\*"(?:size|size_name|sizeName)\\*"\s*:\s*\\*"([A-Za-z0-9\/.]{1,12})\\*"/g, m3, n3 = 0;
    while ((m3 = re3.exec(scriptText)) && n3 < 40) { add(out.sizes, m3[1]); n3++; }
    if (out.sizes.length) add(out.found, 'script-sizes');
  }

  // (هـ) من جدول الخصائص المرئي: "المقاس: S، M، L"
  if (!out.sizes.length) {
    var sizeWords = /^(size|sizes|المقاس|مقاس)$/i;
    document.querySelectorAll('div,li,tr,span,dt,dd').forEach(function (e) {
      if (e.children.length || out.sizes.length > 12) return;
      var t = txt(e);
      if (!t || t.length > 60) return;
      var m = t.match(/^([^:：]{2,12})[:：]\s*(.+)$/);
      if (!m || !sizeWords.test(m[1].trim())) return;
      m[2].split(/[,،/|]+/).forEach(function (x) {
        x = x.trim();
        if (x && x.length < 14) add(out.sizes, x);
      });
    });
    if (out.sizes.length) add(out.found, 'attr-table-sizes');
  }

  // تلميحات للتشخيص لو ما لقينا شي (تُرسل لي فأضبطها بدقة)
  if (!out.sizes.length) {
    out.diag.sizeHints = [];
    document.querySelectorAll('[class*="size" i],[data-size]').forEach(function (e) {
      if (!e.children.length && out.diag.sizeHints.length < 20) {
        var t = txt(e);
        if (t && t.length < 30) out.diag.sizeHints.push({ cls: (e.className || '').toString().slice(0, 70), t: t });
      }
    });
  }
  out.diag.sizeSource = out.sizes.length ? (out.diag.sizesFromDom ? 'dom' : 'schema/state') : 'none';

  /* ---------- ٤) الألوان ---------- */
  // (أ) عنوان الخصيصة: "Color: Black"
  var headSel = ['.bs-main-sales-attr__header-title', '[class*="sales-attr__header"]', '[class*="attr__header"]', '[class*="property"] [class*="title"]'];
  headSel.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (h) {
      var t = txt(h);
      var m = t.match(/^([^:：]{2,18})[:：]\s*(.+)$/);
      if (m && /colou?r|لون|اللون/i.test(m[1])) add(out.colors, m[2]);
    });
  });

  // (ب) عيّنات الألوان
  var swatchSel = ['.bs-color__item', '[class*="color-radio"]', '[class*="color__item"]', '[class*="color-item"]', '[data-color]', '[class*="swatch"]'];
  var swatchClasses = [];
  swatchSel.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (e) {
      if (out.otherColors.length >= 20) return;
      var name = e.getAttribute('data-color') || e.getAttribute('aria-label') || e.getAttribute('title') || '';
      if (!name) { var im = e.querySelector('img'); if (im) name = im.alt || ''; }
      if (!name) { var lab = e.querySelector('[class*="text"],[class*="name"]'); name = lab ? txt(lab) : ''; }
      if (!name || name.length > 40) return;
      add(out.colors, name);
      var a = e.closest('a') || e.querySelector('a');
      out.otherColors.push({ name: name, url: a ? abs(a.getAttribute('href')) : '' });
      if (swatchClasses.length < 8) add(swatchClasses, (e.className || '').toString().slice(0, 60));
    });
  });
  out.diag.colorClasses = swatchClasses;

  // (ج) من كائنات الحالة
  if (!out.colors.length) {
    var st3 = null;
    try { st3 = window.gbRawData || window.rawData || window.__INITIAL_STATE__ || null; } catch (e) {}
    if (st3) {
      walk(st3, function (o) {
        ['color', 'color_name', 'colorName', 'colour', 'saleAttr'].forEach(function (k) {
          var v = o[k];
          if (typeof v === 'string' && v.length < 30) add(out.colors, v);
          else if (v && typeof v === 'object' && typeof v.value === 'string' && v.value.length < 30) add(out.colors, v.value);
        });
      });
    }
  }

  // (د) من جدول الخصائص المرئي: "Color: Black" أو "اللون: أسود"
  if (!out.colors.length) {
    var colorWords = /^(colou?rs?|اللون|لون)$/i;
    document.querySelectorAll('div,li,tr,span,dt,dd').forEach(function (e) {
      if (e.children.length || out.colors.length > 12) return;
      var t = txt(e);
      if (!t || t.length > 60) return;
      var m = t.match(/^([^:：]{2,18})[:：]\s*(.+)$/);
      if (!m || !colorWords.test(m[1].trim())) return;
      m[2].split(/[,،/|]+/).forEach(function (x) { x = x.trim(); if (x && x.length < 30) add(out.colors, x); });
    });
    if (out.colors.length) add(out.found, 'attr-table-colors');
  }

  /* ---------- ٥) الباقي ---------- */
  if (!out.title) { out.title = meta('og:title') || document.title; add(out.found, 'og'); }
  out.title = String(out.title).replace(/\s*[|\-–]\s*(SHEIN|Temu|AliExpress)\s*$/i, '').trim();
  if (out.price == null) {
    var pa = parseFloat(meta('product:price:amount'));
    if (pa) { out.price = pa; out.currency = out.currency || meta('product:price:currency'); }
  }
  if (!out.currency) out.currency = meta('product:price:currency') || meta('og:price:currency') || 'USD';
  if (!out.description) out.description = meta('og:description') || meta('description') || '';

  // ترتيب المقاسات منطقيًا
  var order = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL', 'FREE SIZE', 'ONE SIZE'];
  out.sizes.sort(function (a, b) {
    var ia = order.indexOf(a.toUpperCase()), ib = order.indexOf(b.toUpperCase());
    if (ia > -1 && ib > -1) return ia - ib;
    if (ia > -1) return -1;
    if (ib > -1) return 1;
    return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
  });
  out.diag.colorsFound = out.colors.length;

  /* ---------- ٦) الإخراج ---------- */
  var json = JSON.stringify(out, null, 1);
  window.__LYM_RESULT__ = out;               // للاختبار الآلي

  try { navigator.clipboard.writeText(json); } catch (e) {}

  var old = document.getElementById('__lym_panel');
  if (old) old.remove();
  var box = document.createElement('div');
  box.id = '__lym_panel';
  box.setAttribute('style', 'position:fixed;inset:10px;z-index:2147483647;background:#fffdfb;color:#3a2620;border:2px solid #b38a3e;border-radius:16px;padding:14px;font:15px/1.6 system-ui,sans-serif;direction:rtl;box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:auto');
  box.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
      '<b style="font-size:1.05rem">تم سحب بيانات المنتج</b>' +
      '<button id="__lym_x" style="border:0;background:#eee;border-radius:8px;padding:4px 12px;cursor:pointer;font:inherit">إغلاق</button>' +
    '</div>' +
    '<div style="font-size:.9rem;color:#7b6258;margin:8px 0">' +
      (out.title ? '✓ ' + out.title.replace(/</g, '&lt;') : '✗ بدون عنوان') + '<br>' +
      (out.price != null ? 'السعر: ' + out.price + ' ' + out.currency : 'السعر: ✗') +
      ' · الصور: ' + out.images.length +
      ' · المقاسات: ' + out.sizes.length + (out.sizes.length ? ' (' + out.sizes.join('، ') + ')' : '') +
      ' · الألوان: ' + out.colors.length + (out.colors.length ? ' (' + out.colors.join('، ') + ')' : '') +
    '</div>' +
    '<div style="font-size:.85rem;margin-bottom:8px">' + (out.sizes.length && out.colors.length && out.images.length
      ? 'كل شيء جاهز — الصق في لوحة التحكم.'
      : 'أنقص شيء — الصق في اللوحة وستجد الحقل الفارغ، أو أرسل لي هذا النص.') + '</div>' +
    '<textarea id="__lym_t" style="width:100%;height:160px;font:12px/1.4 monospace;direction:ltr;border:1px solid #ebd9ce;border-radius:10px;padding:8px"></textarea>' +
    '<button id="__lym_c" style="margin-top:8px;width:100%;border:0;background:#3a2620;color:#fff;border-radius:10px;padding:11px;cursor:pointer;font:inherit;font-weight:700">نسخ JSON</button>' +
    '<div id="__lym_ok" style="font-size:.85rem;color:#157a4a;margin-top:6px;text-align:center"></div>';
  document.body.appendChild(box);
  box.querySelector('#__lym_t').value = json;
  box.querySelector('#__lym_x').onclick = function () { box.remove(); };
  box.querySelector('#__lym_t').onclick = function () { this.select(); };
  box.querySelector('#__lym_c').onclick = function () {
    var t = box.querySelector('#__lym_t');
    t.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    if (!ok) { try { navigator.clipboard.writeText(json); ok = true; } catch (e) {} }
    box.querySelector('#__lym_ok').textContent = ok ? 'تم النسخ ✓' : 'حدّد النص وانسخه يدويًا';
  };
})();
