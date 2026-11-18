// netlify/functions/import-product.js
// جلب صفحة منتج من شي إن / تيمو واستخراج بياناتها — بلا أي خدمة مدفوعة.
//
// شي إن (مُختبر فعليًا على us / ar / m.shein.com):
//   • طلب يدّعي أنه متصفح كروم   → يتحوّل غالبًا إلى /risk/challenge (تحقق بشري) — أحيانًا يمرّ أول مرة فقط.
//   • طلب ببصمة بوت معاينة الروابط (Twitterbot — نفس ما يرسله تويتر/تيليجرام لعرض معاينة الرابط)
//     → الصفحة كاملة: JSON-LD + gbRawData = الاسم والسعر والصور والمقاسات والألوان.
//   • روابط المشاركة من التطبيق صفحة وسيطة صغيرة (اسم + صورة واحدة) تحوّل المتصفح بالجافاسكربت:
//       onelink.shein.com/..     → رقم المنتج في  <input id="deeplink" value="sheinlink://applink/goods?data={goods_id}">
//       api-shein.shein.com/h5/sharejump/appjump → رقم المنتج في  shareInfo.id  (shareType = 8)
//     → نأخذ الرقم ونجلب صفحة المنتج: ar.shein.com أولًا (متجر عربي) ثم us.shein.com (منتجات غير متوفرة في موقع).
// تيمو: الصفحة تُرجع العنوان ووسوم meta، والسعر والألوان تُحمّل بالجافاسكربت → استخراج جزئي.

const { fromHtml, cleanUrl, sourceOf } = require('../../extract.js');

// مفتاح anon علني بطبيعته (نفسه الموجود في config.js) — يُستخدم فقط للتحقق من جلسة الأدمن.
const SB_URL = process.env.SUPABASE_URL || 'https://gvbogfyfmkohepmukqmw.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2Ym9nZnlmbWtvaGVwbXVrcW13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxODU3NDksImV4cCI6MjEwNzc2MTc0OX0.A-84w91IS7XZbNlWRRBdXCpoMJFgcfGP8LKYdJqSNV0';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_PREVIEW = 'Twitterbot/1.0';   // بوت معاينة الروابط — شي إن تعطيه الصفحة كاملة بلا تحقق
const BUDGET_MS = 9000;                // حد دوال Netlify 10 ثوانٍ

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

async function isSignedIn(authHeader) {
  if (!authHeader || !SB_KEY) return false;
  try {
    const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: authHeader } });
    return r.ok;
  } catch (e) { return false; }
}

async function timedFetch(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, redirect: 'follow' });
  } finally { clearTimeout(t); }
}

async function fetchPage(target, ua = UA, ms = 20000, extra = {}) {
  const headers = Object.assign(ua === UA ? {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  } : {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8'
  }, extra);
  const r = await timedFetch(target, { headers }, ms);
  return { status: r.status, html: await r.text(), finalUrl: r.url || target };
}

// رابط مشاركة من تطبيق شي إن؟ (onelink / appjump / shein.top)
function isShareLink(u) {
  let h = '', path = '';
  try { const x = new URL(u); h = x.hostname.toLowerCase(); path = x.pathname; } catch (e) { return false; }
  return h === 'onelink.shein.com' || /(^|\.)shein\.top$/.test(h) || (/(^|\.)api-shein\.shein\.com$/.test(h) && /\/sharejump\//i.test(path));
}

const unent = v => String(v).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

// كائن JSON يبدأ بعد «name =» (بموازنة الأقواس)
function jsonAfter(html, name) {
  const i = html.indexOf(name);
  if (i < 0) return null;
  const j = html.indexOf('{', i);
  if (j < 0 || j - i > 40) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = j; k < Math.min(html.length, j + 20000); k++) {
    const c = html[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(j, k + 1)); } catch (e) { return null; } }
  }
  return null;
}

// رقم المنتج من صفحة المشاركة الوسيطة
function shareGoodsId(html) {
  const s = String(html || '');
  // onelink: <input id="deeplink" value="sheinlink://applink/goods?data=%7B%22goods_id%22%3A%2277417590%22...">
  const dl = s.match(/id="deeplink"\s+value="([^"]+)"/i);
  if (dl) {
    const v = unent(dl[1]);
    const m = v.match(/[?&]data=([^&]+)/);
    if (m) { try { const d = JSON.parse(decodeURIComponent(m[1])); if (/^\d{5,}$/.test(String(d.goods_id || ''))) return String(d.goods_id); } catch (e) {} }
    let dec = v; try { dec = decodeURIComponent(v); } catch (e) {}
    const m2 = dec.match(/goods_id"?\s*[:=]\s*"?(\d{5,})/);
    if (m2) return m2[1];
  }
  // appjump: shareInfo = {..."shareType":8,..."id":"77417590",...}
  const info = jsonAfter(s, 'shareInfo');
  if (info) {
    if (/^\d{5,}$/.test(String(info.goodsId || ''))) return String(info.goodsId);
    if (Number(info.shareType) === 8 && /^\d{5,}$/.test(String(info.id || ''))) return String(info.id);
  }
  // رابط منتج صريح داخل الصفحة (input id="url")
  const u = s.match(/id="url"\s+value="([^"]+)"/i);
  if (u) { const m3 = unent(u[1]).match(/-p-(\d{5,})/); if (m3) return m3[1]; }
  return '';
}

// صفحة المنتج برقمه: الموقع العربي أولًا ثم الأمريكي (بعض المنتجات غير متوفرة في موقع)
const SHEIN_SITES = ['https://ar.shein.com', 'https://us.shein.com'];
async function sheinById(id, extra, timeLeft) {
  for (const site of SHEIN_SITES) {
    if (timeLeft() < 1500) break;
    try {
      const p = await fetchPage(site + '/x-p-' + id + '.html', UA_PREVIEW, Math.min(timeLeft(), 6000), extra);
      if (classify(p.html, p.finalUrl) !== 'ok') continue;
      const d = fromHtml(p.html, p.finalUrl);
      if (d.ok && d.title) return { page: p, data: d };
    } catch (e) { /* الموقع التالي */ }
  }
  return null;
}

// تصنيف ما وصل إلينا: صفحة منتج حقيقية / تحقق بشري / حجب صريح
function classify(html, finalUrl) {
  const head = String(html || '').slice(0, 8000);
  if (/(\/risk\/challenge|captcha_type=)/i.test(finalUrl || '')) return 'challenge';
  if (/(captcha-delivery|_Incapsula_|px-captcha|cf-mitigated|Reference #\d|Access Denied|Please verify you are a human|Security verification|Just a moment)/i.test(head)) return 'challenge';
  if (!html || html.length < 500) return 'empty';
  return 'ok';
}

const HINTS = {
  challenge: 'الموقع طلب تحققًا بشريًا (شي إن يفعل هذا مع كل طلب من خادم). هذا ليس خطأً في متجرك — استخدم «زر السحب» أو «لصق نص الصفحة»، وكلاهما مجاني ويعمل من متصفحك.',
  empty: 'وصل رد فارغ من الموقع. جرّب مرة أخرى، أو استخدم «زر السحب».',
  partial: 'استخرجنا جزءًا من البيانات. السعر والألوان في تيمو تُحمّل بالجافاسكربت، فأكملها يدويًا أو استخدم «زر السحب».'
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return reply(405, { error: 'method not allowed' });
    const h = event.headers || {};
    if (!(await isSignedIn(h.authorization || h.Authorization))) return reply(401, { error: 'سجّل الدخول أولاً' });

    const q = event.queryStringParameters || {};
    const cleaned = cleanUrl(q.url);
    if (!cleaned) return reply(400, { error: 'الرابط غير صالح. الصق رابط منتج كامل يبدأ بـ https://' });
    cleaned.url = cleaned.url.replace(/^http:\/\//i, 'https://');   // روابط مشاركة التطبيق تبدأ أحيانًا بـ http
    if (!/^https:/.test(cleaned.url)) return reply(400, { error: 'الرابط يجب أن يكون https' });

    const src = sourceOf(cleaned.url);
    const t0 = Date.now();
    const left = () => Math.max(1500, BUDGET_MS - (Date.now() - t0));

    // شي إن: بصمة معاينة الروابط أولًا (تعطي الصفحة كاملة)، ثم كروم كاحتياط
    const uas = src === 'shein' ? [UA_PREVIEW, UA] : [UA];
    // المتجر بالدولار: نطلب سعر شي إن بالدولار دائمًا (ar.shein.com يعطي ريال افتراضيًا)
    const extra = src === 'shein' ? { Cookie: 'currency=USD' } : {};
    let page = null, kind = 'empty', netErr = null;
    for (const ua of uas) {
      try {
        const p = await fetchPage(cleaned.url, ua, left(), extra);
        const k = classify(p.html, p.finalUrl);
        if (!page || k === 'ok') { page = p; kind = k; }
        if (k === 'ok') break;
      } catch (e) { netErr = netErr || e; }
      if (Date.now() - t0 > BUDGET_MS - 2000) break;
    }

    if (!page) {
      const e = netErr || new Error('no response');
      return reply(200, {
        ok: false, blocked: true, reason: 'network', source: src, url: cleaned.url,
        error: 'تعذّر الوصول إلى الموقع من الخادم',
        reasons: [e.name === 'AbortError' ? 'انتهت المهلة' : e.message],
        hint: HINTS.challenge
      });
    }

    // شي إن: رابط مشاركة، أو صفحة بلا بيانات منتج → رقم المنتج → صفحة المنتج الحقيقية
    let data = kind === 'ok' ? fromHtml(page.html, page.finalUrl) : null;
    if (src === 'shein') {
      const share = isShareLink(cleaned.url) || isShareLink(page.finalUrl || '');
      const thin = !data || !data.ok || (data.price == null && !data.sizes.length && !data.colors.length && data.images.length <= 1);
      if (share || thin) {
        const id = (cleaned.url.match(/-p-(\d{5,})/) || [])[1] || (kind === 'ok' ? shareGoodsId(page.html) : '');
        if (id) {
          const timeLeft = () => BUDGET_MS - (Date.now() - t0);
          const got = await sheinById(id, extra, timeLeft);
          if (got) { page = got.page; kind = 'ok'; data = got.data; }
        }
      }
    }

    if (kind !== 'ok') {
      return reply(200, {
        ok: false,
        blocked: true,
        reason: kind,
        source: src,
        url: cleaned.url,
        error: kind === 'challenge' ? 'الموقع طلب تحققًا بشريًا' : 'لم نصل إلى صفحة المنتج',
        reasons: ['الاستجابة: ' + kind, 'الرابط النهائي: ' + page.finalUrl],
        hint: HINTS[kind] || HINTS.challenge
      });
    }

    data = data || fromHtml(page.html, page.finalUrl);
    data.via = 'direct';
    data.source = src;

    if (!data.ok) {
      data.blocked = false;
      data.error = 'وصلت الصفحة لكن ما لقينا فيها بيانات منتج';
      data.hint = HINTS.partial;
      return reply(200, data);
    }

    // استخراج جزئي: بيانات ناقصة (شائع في تيمو)
    const missing = [];
    if (data.price == null) missing.push('السعر');
    if (!data.images.length) missing.push('الصور');
    if (!data.colors.length && !data.sizes.length) missing.push('الخيارات');
    if (missing.length) {
      data.partial = true;
      data.error = 'استخراج جزئي — ناقص: ' + missing.join('، ');
      data.hint = HINTS.partial;
    }
    return reply(200, data);
  } catch (e) {
    return reply(502, { error: e.message || 'خطأ غير متوقع' });
  }
};
