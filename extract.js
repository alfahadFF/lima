/* extract.js — محرّك استخراج بيانات المنتج من صفحة شي إن / تيمو / علي إكسبريس
 * يعمل في مكانين بنفس الكود:
 *   1) داخل دالة Netlify  : require('./extract.js')
 *   2) داخل المتصفح       : <script src="extract.js"> ثم Extract.fromHtml(html, url)
 * الفكرة: لا نعتمد على مكان واحد للبيانات. نجرّب بالترتيب:
 *   JSON-LD  ← ثم الحالة المدمجة في الصفحة (__NEXT_DATA__ / gbRawData / rawData / __INITIAL_STATE__) ← ثم وسوم meta
 *   ولا نُرجع خطأ إلا إذا فشلنا في كل شيء.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Extract = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const IMG_RE = /\.(jpe?g|png|webp|avif)(\?[^"'\\\s]*)?$/i;
  const IMG_HOSTS = /(ltwebstatic|shein|temu|kwcdn|kwimgs|aliexpress|alicdn|aecdn|kfcdn|img\.|images\.)/i;

  const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };

  function sourceOf(url) {
    const h = hostOf(url);
    if (/(^|\.)shein\.[a-z.]+$/.test(h)) return 'shein';
    if (/(^|\.)temu\.com$/.test(h)) return 'temu';
    if (/(^|\.)aliexpress\.[a-z.]+$/.test(h)) return 'aliexpress';
    if (/(^|\.)1688\.com$/.test(h)) return '1688';
    if (/(^|\.)taobao\.[a-z.]+$/.test(h)) return 'taobao';
    return 'other';
  }

  /* ---------- أدوات نصية ---------- */

  const decode = s => String(s)
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)));

  function safeChar(n) { try { return String.fromCodePoint(n); } catch (e) { return ''; } }

  const stripHtml = s => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

  function tidyTitle(t) {
    return stripHtml(t)
      .replace(/\s*[|\-–]\s*(SHEIN|Temu|AliExpress|1688)\s*$/i, '')
      .replace(/\s*(Wholesale|Free Shipping|Online)\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 300);
  }

  function tidyImage(u) {
    if (!u) return null;
    let s = decode(String(u)).trim().replace(/^\/\//, 'https://').replace(/^http:\/\//i, 'https://');
    if (!/^https?:\/\//i.test(s)) return null;
    // شي إن: إزالة لاحقة المصغّرة للحصول على الصورة الكاملة
    s = s.replace(/_thumbnail_\d+x\d+(?:_crop)?/i, '').replace(/_small_\d+/i, '');
    // تيمو وبعض المواقع: إزالة معاملات التصغير
    s = s.replace(/[?&](image_?view|imageView2|imageView|resize|x-oss-process)=[^&]*/gi, '');
    return s;
  }

  const num = v => {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const m = String(v == null ? '' : v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };

  /* ---------- قراءة JSON من داخل HTML ---------- */

  // يرجع نص JSON المتوازن بدءًا من أول { أو [ بعد الموضع المحدد
  function balanced(text, from) {
    let i = from;
    while (i < text.length && text[i] !== '{' && text[i] !== '[') i++;
    if (i >= text.length) return null;
    const open = text[i], close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (!depth) return text.slice(i, j + 1); }
    }
    return null;
  }

  function tryParse(txt) {
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  // كل الكتل JSON المؤهلة للاستخراج
  function jsonBlobs(html) {
    const out = [];
    const push = (val, tag) => { if (val && typeof val === 'object') out.push({ tag, val }); };

    // JSON-LD
    const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = ldRe.exec(html))) push(tryParse(m[1].trim()), 'jsonld');

    // <script type="application/json"> عام (Next.js / Nuxt / حالات مدمجة)
    const jRe = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    while ((m = jRe.exec(html))) push(tryParse(m[1].trim()), 'script-json');

    // window.__X__ = { ... }  و  var X = { ... }
    const varRe = /(?:window\.|var\s+|const\s+|let\s+)(__(?:NEXT_DATA|NUXT|INITIAL_STATE|PRELOADED_STATE|APOLLO_STATE)__|gbRawData|rawData|gbCommonData|__INITIAL_STATE|__NUXT__)\s*=\s*/g;
    while ((m = varRe.exec(html))) {
      const raw = balanced(html, m.index + m[0].length);
      const val = tryParse(raw) || (() => { try { return JSON.parse(raw.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"')); } catch (e) { return null; } })();
      push(val, m[1]);
    }
    return out;
  }

  /* ---------- المرور على شجرة JSON ---------- */

  function walk(node, visit, state) {
    if (state.count > 40000 || state.depth > 22) return;
    if (!node || typeof node !== 'object') return;
    state.count++;
    visit(node);
    state.depth++;
    if (Array.isArray(node)) {
      for (const v of node) if (v && typeof v === 'object') walk(v, visit, state);
    } else {
      for (const k in node) if (Object.prototype.hasOwnProperty.call(node, k) && node[k] && typeof node[k] === 'object') walk(node[k], visit, state);
    }
    state.depth--;
  }

  const TITLE_KEY = /^(goods_name|goodsName|productName|product_name|goods_title|goodsTitle|title|name|subject)$/i;
  const PRICE_KEY = /(salePrice|sale_price|nowPrice|now_price|currentPrice|current_price|minPrice|min_price|activityPrice|activity_price|discountPrice|promotionPrice|sellPrice|price|amount)$/i;
  const CUR_KEY = /^(currency|currencyCode|currency_code|priceCurrency|currencySymbol)$/i;
  const IMG_KEY = /(image|img|images|imageUrl|image_url|goods_img|goodsImage|gallery|picture|pics|thumb|thumbUrl|photo)$/i;
  const COLOR_KEY = /^(colou?r|colou?r_?name|colou?rs|colorName)$/i;
  const SIZE_KEY = /^(size|sizes|size_?name|sizeName|尺码)$/i;

  function scanTrees(blobs) {
    const cand = { titles: [], prices: [], currencies: [], images: [], colors: [], sizes: [], skus: [] };
    const addImg = (v) => {
      const u = tidyImage(v);
      if (u && IMG_RE.test(u.split('?')[0]) && IMG_HOSTS.test(u)) cand.images.push(u);
    };
    const addAttr = (arr, key, sink) => {
      if (!Array.isArray(arr)) return;
      for (const x of arr.slice(0, 60)) {
        if (typeof x === 'string' && x.length < 40) sink.push(x.trim());
        else if (x && typeof x === 'object') {
          for (const k in x) if (key.test(k) && (typeof x[k] === 'string') && x[k].length < 60) sink.push(String(x[k]).trim());
        }
      }
    };

    for (const { val, tag } of blobs) {
      walk(val, (obj) => {
        if (Array.isArray(obj)) return;
        const keys = Object.keys(obj);
        // عنوان
        for (const k of keys) {
          const v = obj[k];
          if (typeof v !== 'string') continue;
          if (TITLE_KEY.test(k) && v.length >= 8 && v.length <= 400) {
            const w = /^(goods_name|goodsName|productName|product_name)$/i.test(k) ? 5 : /^(title|subject)$/i.test(k) ? 3 : 2;
            cand.titles.push({ v: v, w: w + Math.min(v.length / 100, 2), tag });
          }
          if (CUR_KEY.test(k) && /^[A-Za-z]{3}$/.test(v)) cand.currencies.push(v.toUpperCase());
          if (IMG_KEY.test(k) && /^https?:|^\/\//.test(v)) addImg(v);
          if (SIZE_KEY.test(k) && v.length < 20) cand.sizes.push(v);
          if (COLOR_KEY.test(k) && v.length < 40) cand.colors.push(v);
        }
        // سعر
        for (const k of keys) {
          if (!PRICE_KEY.test(k)) continue;
          const n = num(obj[k]);
          if (n == null || n <= 0 || n > 100000) continue;
          const strong = /(sale|now|current|min|activity|discount|promotion)/i.test(k) ? 3 : 1;
          cand.prices.push({ v: n, w: strong, key: k, tag });
        }
        // صور/خيارات داخل مصفوفات
        for (const k of keys) {
          const v = obj[k];
          if (Array.isArray(v)) {
            if (IMG_KEY.test(k)) v.forEach((x) => { if (typeof x === 'string') addImg(x); else if (x && typeof x === 'object') Object.values(x).forEach((y) => typeof y === 'string' && addImg(y)); });
            if (COLOR_KEY.test(k)) addAttr(v, COLOR_KEY, cand.colors);
            if (SIZE_KEY.test(k)) addAttr(v, SIZE_KEY, cand.sizes);
          }
        }
        // SKU / خيارات
        if ('sku_list' in obj || 'skuList' in obj || 'variants' in obj) {
          const list = obj.sku_list || obj.skuList || obj.variants;
          if (Array.isArray(list)) cand.skus.push(...list.slice(0, 200));
        }
      }, { count: 0, depth: 0 });
    }
    return cand;
  }

  /* ---------- JSON-LD ---------- */

  function fromJsonLd(blobs) {
    const out = {};
    const findProduct = (val) => {
      const list = [];
      const collect = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(collect);
        if (n['@graph']) collect(n['@graph']);
        const t = n['@type'];
        if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) list.push(n);
        for (const k in n) if (n[k] && typeof n[k] === 'object') collect(n[k]);
      };
      collect(val);
      return list;
    };
    for (const b of blobs) {
      if (b.tag !== 'jsonld') continue;
      for (const p of findProduct(b.val)) {
        out.title = out.title || p.name;
        out.description = out.description || p.description;
        const imgs = [].concat(p.image || []).map((x) => (typeof x === 'string' ? x : x && (x.url || x.contentUrl))).filter(Boolean);
        if (imgs.length) out.images = (out.images || []).concat(imgs);
        const offers = [].concat(p.offers || [])[0];
        if (offers) {
          out.price = out.price ?? num(offers.price ?? offers.lowPrice ?? offers.highPrice);
          out.currency = out.currency || (offers.priceCurrency || '').toUpperCase() || undefined;
          const av = String(offers.availability || '');
          if (av) out.availability = av;
        }
        if (p.color) out.colors = [].concat(p.color).filter((x) => typeof x === 'string');
        if (p.size) out.sizes = [].concat(p.size).filter((x) => typeof x === 'string');
      }
    }
    return out;
  }

  /* ---------- وسوم meta ---------- */

  function metaMap(html) {
    const out = {};
    const re = /<meta\s+([^>]+)>/gi;
    let m;
    while ((m = re.exec(html))) {
      const attrs = m[1];
      const key = /(?:property|name|itemprop)\s*=\s*(["'])([^"']+)\1/i.exec(attrs);
      const val = /content\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
      if (key && val) out[key[2].toLowerCase()] = decode(val[2]);
    }
    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (titleM) out['<title>'] = decode(titleM[1]);
    return out;
  }

  /* ---------- الواجهة الرئيسية ---------- */

  function fromHtml(html, url) {
    html = String(html || '');
    const notes = [];
    const meta = metaMap(html);
    const blobs = jsonBlobs(html);
    const cand = scanTrees(blobs);
    const ld = fromJsonLd(blobs);

    // العنوان: JSON-LD ← الحالة المدمجة ← og:title ← <title>
    let title = tidyTitle(ld.title || '');
    if (!title) {
      cand.titles.sort((a, b) => b.w - a.w);
      title = tidyTitle((cand.titles[0] || {}).v || '');
    }
    if (!title) title = tidyTitle(meta['og:title'] || meta['twitter:title'] || meta['<title>'] || '');
    if (!title) notes.push('لم نجد عنوان المنتج — اكتبه يدويًا.');

    // السعر: JSON-LD ← الحالة المدمجة (مع تفضيل sale/now) ← meta
    let price = ld.price ?? null;
    let currency = (ld.currency || '').toUpperCase() || null;
    if (price == null) {
      cand.prices.sort((a, b) => b.w - a.w || a.v - b.v);
      if (cand.prices.length) price = cand.prices[0].v;
    }
    if (price == null) price = num(meta['product:price:amount'] || meta['og:price:amount'] || meta['product:sale_price:amount']);
    if (!currency) currency = (meta['product:price:currency'] || meta['og:price:currency'] || cand.currencies[0] || '').toUpperCase() || null;
    if (price == null) notes.push('لم نجد السعر — أدخله يدويًا.');

    // الصور: JSON-LD ← og:image ← الحالة المدمجة ← <img> في الصفحة
    let images = (ld.images || []).map(tidyImage).filter(Boolean);
    [meta['og:image'], meta['og:image:secure_url'], meta['twitter:image']].forEach((u) => { const x = tidyImage(u); if (x) images.push(x); });
    images = images.concat(cand.images);
    if (images.length < 3) {
      const re = /<img[^>]+(?:src|data-src|data-original)\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(html))) { const x = tidyImage(m[1]); if (x && IMG_HOSTS.test(x) && IMG_RE.test(x.split('?')[0])) images.push(x); }
    }
    images = dedupeImages(images).slice(0, 12);
    if (!images.length) notes.push('لم نجد صور المنتج — الصق روابطها يدويًا.');

    const description = stripHtml(ld.description || meta['og:description'] || meta['description'] || '').slice(0, 1500);

    // الخيارات: الحالة المدمجة (أو SKU) ← JSON-LD
    let colors = uniqStrings(cand.colors);
    let sizes = uniqStrings(cand.sizes);
    if (!colors.length && ld.colors) colors = uniqStrings(ld.colors);
    if (!sizes.length && ld.sizes) sizes = uniqStrings(ld.sizes);
    const skuOut = variantsFromSkus(cand.skus, colors, sizes);

    const filled = [title, price, images.length, description].filter(Boolean).length;
    const confidence = ld.title && (ld.price != null || (ld.images || []).length) ? 'high'
      : filled >= 2 ? 'medium' : filled >= 1 ? 'low' : 'none';

    if (currency && currency !== 'USD') notes.push('السعر بعملة ' + currency + ' — حوّله للدولار قبل الحفظ.');
    if (!description) notes.push('لا يوجد وصف — اكتب وصفًا عربيًا قصيرًا.');
    if (!sizes.length && !colors.length) notes.push('لم نستخرج الخيارات — اكتب الألوان والمقاسات يدويًا.');

    return {
      ok: !!title && (price != null || images.length > 0 || !!description),
      source: sourceOf(url),
      url: url || '',
      title: title || '',
      price: price == null ? null : price,
      currency: currency || 'USD',
      description,
      images,
      colors,
      sizes,
      soldOut: skuOut.soldOut,
      inStock: skuOut.inStock,
      confidence,
      notes,
      debug: { blobs: blobs.map((b) => b.tag), imagesFound: images.length }
    };
  }

  function variantsFromSkus(skus, colors, sizes) {
    const soldOut = [], inStock = [];
    for (const s of skus) {
      if (!s || typeof s !== 'object') continue;
      const label = [].concat(s.color || s.color_name || s.size || '', s.size || s.size_name || '').filter(Boolean).join(' ');
      const stock = num(s.stock ?? s.inventory ?? s.stockNum ?? s.quantity ?? s.inventory_num);
      if (label && stock != null) (stock > 0 ? inStock : soldOut).push(label.trim());
      // لو الـ SKU فيه لون/مقاس صريح أضفه للقوائم
      if (typeof s.color_name === 'string' && s.color_name.length < 40 && !colors.includes(s.color_name)) colors.push(s.color_name);
      if (typeof s.size === 'string' && s.size.length < 20 && !sizes.includes(s.size)) sizes.push(s.size);
    }
    return { soldOut: uniqStrings(soldOut), inStock: uniqStrings(inStock) };
  }

  function dedupeImages(list) {
    const seen = new Map();
    for (const raw of list) {
      const u = tidyImage(raw);
      if (!u) continue;
      const key = u.split('?')[0].replace(/\/\d+x\d+\//, '/').toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, u);
    }
    return [...seen.values()];
  }

  function uniqStrings(a) {
    const out = [];
    const seen = new Set();
    for (const x of a || []) {
      const s = String(x || '').trim();
      if (!s || s.length > 40) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); out.push(s);
    }
    return out.slice(0, 30);
  }

  /* ---------- الوضع النصي: للمتصفحات على الهاتف ----------
   * على الهاتف لا يعمل زر السحب ولا Ctrl+U، لكن يمكن تحديد نص الصفحة المرئي ونسخه.
   * من هذا النص نستخرج: العنوان، السعر والعملة، المقاسات، الألوان، والوصف.
   * الصور لا تُستخرج من النص — ننبّه لذلك.
   */

  const COLORS = [
    ['أسود', 'black'], ['أبيض', 'white'], ['وردي', 'pink'], ['أحمر', 'red'], ['أزرق', 'blue'],
    ['أخضر', 'green'], ['بيج', 'beige'], ['بني', 'brown'], ['رمادي', 'grey|gray'], ['كحلي', 'navy'],
    ['بنفسجي', 'purple'], ['أصفر', 'yellow'], ['برتقالي', 'orange'], ['خاكي', 'khaki'],
    ['عاجي', 'ivory'], ['ذهبي', 'gold'], ['فضي', 'silver'], ['خمري', 'burgundy|wine'],
    ['تركوازي', 'turquoise'], ['متعدد', 'multi']
  ];

  const SIZE_TOKEN = /^(?:x{0,2}s|m|x{0,3}l|[2-5]xl|[0-9]{2}|free size|one size)$/i;

  function fromText(text, url) {
    const raw = String(text || '').replace(/\r/g, '');
    const lines = raw.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const flat = lines.join('\n');
    const oneline = lines.join(' ');
    const notes = [];

    // العنوان: أول سطر معقول، مع تجاهل أسطر الأسعار وأسماء المواقع والعبارات التسويقية
    const BAD = /^(سلة|الرئيسية|copyright|all rights|sign in|تسجيل الدخول|توصيل مجاني|free shipping|sold out|نفدت الكمية|\d+\s*(reviews?|تقييم)|[$€£]\s*\d)/i;
    const SITE = /^(shein|temu|aliexpress|amazon|شي\s?إن|تيمو)\s*$/i;
    const isPriceLine = (s) => /^[-–—•\s]*([$€£]|US\$|USD|SAR|AED|ر\.س|د\.إ)?\s*\d+(?:[.,]\d{1,2})?\s*([$€£]|US\$|USD|SAR|AED|ر\.س|د\.إ)?\s*(%|off|خصم)?$/i.test(s);
    let title = '';
    for (const l of lines.slice(0, 40)) {
      if (l.length < 12 || l.length > 220) continue;
      if (BAD.test(l) || isPriceLine(l)) continue;
      if (SITE.test(l)) continue;                                      // اسم الموقع وحده
      if (/^https?:\/\//i.test(l) || /\bwww\./i.test(l)) continue;   // أسطر الروابط ليست عنوانًا
      if (!/[a-z\u0600-\u06FF]/i.test(l)) continue;
      if ((l.match(/[a-z]/gi) || []).length < 6 && (l.match(/[\u0600-\u06FF]/g) || []).length < 6) continue;
      title = l;
      break;
    }
    if (!title) notes.push('لم نجد عنوانًا واضحًا — اكتبه يدويًا.');

    // السعر: أول رقم مرتبط برمز عملة (أو رمز عملة بعد الرقم)
    let price = null, currency = null;
    const CUR = [
      [/(?:US\$|USD|\$)/i, 'USD'], [/(?:SAR|ر\.?\s?س)/i, 'SAR'],
      [/(?:AED|د\.?\s?إ)/i, 'AED'], [/€/, 'EUR'], [/£/, 'GBP']
    ];
    const numRe = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:\.\d{1,2})?)/;
    const priceRes = [
      /(?:US\$|USD|\$|SAR|ر\.?\s?س|AED|د\.?\s?إ|€|£)\s*(\d+(?:[.,]\d{1,2})?)/i,
      /(\d+(?:[.,]\d{1,2})?)\s*(?:US\$|USD|\$|SAR|ر\.?\s?س|AED|د\.?\s?إ|€|£)/i
    ];
    for (const re of priceRes) {
      const m = oneline.match(re);
      if (!m) continue;
      const v = parseFloat(String(m[1]).replace(/,/g, '.'));
      if (!(v > 0) || v > 100000) continue;
      price = v;
      for (const [rx, code] of CUR) if (rx.test(m[0])) { currency = code; break; }
      break;
    }
    // احتياط: سطر فيه كلمة "السعر"/"Price" ورقم
    if (price == null) {
      const m = oneline.match(/(?:السعر|price|سعر)\D{0,12}(\d+(?:[.,]\d{1,2})?)/i);
      if (m) price = parseFloat(String(m[1]).replace(/,/g, '.'));
    }
    if (price == null) notes.push('لم نجد السعر — أدخله يدويًا.');

    // المقاسات: توكنات مفردة أو سطر يبدأ بـ Size
    const sizeSet = new Set();
    const sizeLine = oneline.match(/(?:size|المقاس|مقاس)\s*[:：]?\s*([A-Za-z0-9 ,/\-]{2,60})/i);
    if (sizeLine) {
      sizeLine[1].split(/[ ,/|]+/).map((x) => x.trim()).filter((x) => SIZE_TOKEN.test(x)).forEach((x) => sizeSet.add(x.toUpperCase()));
    }
    lines.forEach((l) => {
      const parts = l.split(/[\s,|/]+/).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 3 && parts.length <= 10) {
        const hits = parts.filter((x) => SIZE_TOKEN.test(x));
        if (hits.length >= Math.max(3, parts.length - 1)) hits.forEach((x) => sizeSet.add(x.toUpperCase()));
      }
    });
    let sizes = [...sizeSet];
    // ترتيب منطقي
    const order = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL', 'FREE SIZE', 'ONE SIZE'];
    sizes.sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia > -1 && ib > -1) return ia - ib;
      if (ia > -1) return -1;
      if (ib > -1) return 1;
      return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
    });

    // الألوان
    const colors = [];
    const seenC = new Set();
    COLORS.forEach(([ar, en]) => {
      const rx = new RegExp('(^|[^\\p{L}])(' + en + ')([^\\p{L}]|$)', 'iu');
      const rxAr = new RegExp('(^|[^\\p{L}])(' + ar + ')([^\\p{L}]|$)', 'u');
      if (rx.test(oneline) || rxAr.test(oneline)) {
        if (!seenC.has(ar)) { seenC.add(ar); colors.push(ar); }
      }
    });

    // الوصف: أطول سطر معقول غير العنوان
    let description = '';
    for (const l of lines) {
      if (l === title || l.length < 40 || l.length > 700) continue;
      if (isPriceLine(l)) continue;
      if (l.length > description.length) description = l;
    }

    const filled = [title, price, description].filter(Boolean).length;
    if (!colors.length && !sizes.length) notes.push('لم نستخرج ألوانًا أو مقاسات — اكتبها يدويًا.');
    notes.push('الصور لا تُستخرج من النص — أضف روابطها، أو استخدم زر السحب من الحاسوب لجلبها تلقائيًا.');

    return {
      ok: !!(title && (price != null || description)),
      mode: 'text',
      source: sourceOf(url),
      url: url || '',
      title: title || '',
      price: price == null ? null : price,
      currency: currency || 'USD',
      description,
      images: [],
      colors,
      sizes,
      soldOut: [],
      inStock: [],
      confidence: filled >= 2 ? 'medium' : filled >= 1 ? 'low' : 'none',
      notes,
      debug: { lines: lines.length, mode: 'text' }
    };
  }

  /* ---------- استخراج الرابط والاسم من رابط أو نص مشاركة (بلا أي شبكة) ----------
   * أبسط طريق: تلصق رابط شي إن (أو نص المشاركة من التطبيق) فنُرجع
   * الرابط النظيف + الاسم المستنبط + معرّف المنتج. والباقي تكمّله أنت.
   */
  function fromShare(input) {
    const text = String(input || '').replace(/&amp;/g, '&');
    const m = text.match(/https?:\/\/[^\s"'<>]+/);
    if (!m) return null;
    let u;
    try { u = new URL(decode(m[0])); } catch (e) { return null; }

    const red = u.searchParams.get('redirection') || u.searchParams.get('url');
    if (red && /^https?:/.test(red)) { try { u = new URL(decodeURIComponent(red)); } catch (e) {} }

    let slug = (u.pathname.split('/').pop() || '');
    try { slug = decodeURIComponent(slug); } catch (e) {}
    slug = slug.replace(/\.html?$/i, '');

    const idm = slug.match(/-p-(\d+)/) || slug.match(/-g-(\d+)/) || slug.match(/(\d{6,})/);
    const id = idm ? idm[1] : '';

    let fromSlug = slug
      .replace(/-p-\d+.*$/i, '')
      .replace(/-g-\d+.*$/i, '')
      .replace(/^(p|g|goods|product)[-_]/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+\d{4,}.*$/, '')
      .trim();

    const words = fromSlug.split(/\s+/).filter(w => /[a-z\u0600-\u06FF]{3,}/i.test(w));
    if (words.length < 2) fromSlug = '';

    const before = text.replace(m[0], '').replace(/\s+/g, ' ').trim();
    const fromText = (before.length > 3 && before.length < 200 && !/[<>=]/.test(before)) ? before : '';

    // إزالة معاملات التتبّع
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'url_from',
      'share_from', 'ref', 'ref_', 'aff_id', 'tt_from', 'code'].forEach(k => u.searchParams.delete(k));
    const url = u.origin + u.pathname + (u.search ? '?' + u.searchParams.toString() : '');
    return {
      ok: true,
      mode: 'link',
      url,
      source: sourceOf(url),
      id,
      title: tidyTitle(fromText || fromSlug),
      price: null, currency: 'USD', description: '', images: [],
      colors: [], sizes: [], soldOut: [],
      confidence: 'low',
      notes: ['استُخرج الرابط والاسم فقط — أكمل السعر والصور.']
    };
  }


  /* ---------- توجيه ما لصقه المستخدم ----------
   * يرجع نوع المدخل حتى تعرف الواجهة ماذا تفعل:
   *   json     → ملصوق JSON من زر السحب
   *   url+text → المستخدم نسخ الصفحة كاملة (فيها رابط) → نستخرج من النص
   *   url      → رابط فقط → نحاول الجلب من الخادم
   *   text     → نص فقط
   */
  function route(value) {
    const s = String(value || '').trim();
    if (/^[{[]/.test(s)) return { kind: 'json' };
    const link = cleanUrl(s);
    const rest = s.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    if (link && rest.length > 300) return { kind: 'url+text', url: link.url, source: link.source, text: s };
    if (link) return { kind: 'url', url: link.url, source: link.source };
    return { kind: 'text', text: s };
  }

  /* ---------- تحويل رابط المشاركة إلى رابط نظيف ---------- */
  function cleanUrl(raw) {
    const m = String(raw || '').match(/https?:\/\/[^\s"'<>]+/);
    if (!m) return null;
    let u;
    try { u = new URL(decode(m[0])); } catch (e) { return null; }
    const red = u.searchParams.get('redirection') || u.searchParams.get('url') || u.searchParams.get('redirect');
    if (red && /^https?:/.test(red)) { try { u = new URL(decodeURIComponent(red)); } catch (e) {} }
    // إزالة معاملات التتبّع
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'url_from', 'share_from', 'ref', 'ref_', 'aff_id', 'code', 'tt_from'].forEach((k) => u.searchParams.delete(k));
    return { url: u.origin + u.pathname + (u.search ? '?' + u.searchParams.toString() : ''), source: sourceOf(u.href) };
  }

  return { fromHtml, fromText, fromShare, cleanUrl, route, sourceOf, tidyTitle, tidyImage, version: '1.3.0' };
}));
