// netlify/functions/import-product.js
// جلب صفحة منتج من شي إن / تيمو واستخراج بياناتها — بلا أي خدمة مدفوعة.
//
// شي إن (مُختبر فعليًا على us / ar / m.shein.com):
//   • طلب يدّعي أنه متصفح كروم   → يتحوّل غالبًا إلى /risk/challenge (تحقق بشري) — أحيانًا يمرّ أول مرة فقط.
//   • طلب ببصمة بوت معاينة الروابط (Twitterbot — نفس ما يرسله تويتر/تيليجرام لعرض معاينة الرابط)
//     → الصفحة كاملة: JSON-LD + gbRawData = الاسم والسعر والصور والمقاسات والألوان.
//   • روابط المشاركة من التطبيق (api-shein.shein.com/h5/sharejump/...) صفحة وسيطة فيها اسم وصورة فقط
//     → نأخذ منها رقم المنتج (goodsId) ونجلب صفحة المنتج الحقيقية.
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

// رابط مشاركة من تطبيق شي إن؟
const isShareJump = u => /(^|\.)api-shein\.shein\.com$/i.test(hostOf(u)) && /\/sharejump\//i.test(u);
function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }

// رقم المنتج من صفحة المشاركة الوسيطة
function goodsIdOf(html) {
  const s = String(html || '');
  const m = s.match(/"goodsId"\s*:\s*"?(\d{5,})/) || s.match(/"deepLink"\s*:\s*"[^"]*?goods_id=(\d{5,})/)
    || s.match(/"originalUrl"\s*:\s*"[^"]*?-p-(\d{5,})/);
  return m ? m[1] : '';
}

// موقع شي إن المناسب لرابط المشاركة: الدول العربية → ar.shein.com ، غيرها → us.shein.com
const AR_CC = ['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'JO', 'LB', 'EG', 'IQ', 'MA', 'SY', 'PS', 'YE', 'LY', 'TN', 'DZ', 'SD'];
function shareSite(shareUrl, html) {
  let cc = '';
  try { cc = (new URL(shareUrl).searchParams.get('localcountry') || '').toUpperCase(); } catch (e) {}
  const lang = ((String(html || '').match(/"language"\s*:\s*"([a-z]{2})/i) || [])[1] || '').toLowerCase();
  return (lang === 'ar' || AR_CC.includes(cc)) ? 'https://ar.shein.com' : 'https://us.shein.com';
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

    // رابط مشاركة من التطبيق → صفحة المنتج الحقيقية
    if (kind === 'ok' && isShareJump(page.finalUrl || cleaned.url)) {
      const id = goodsIdOf(page.html);
      if (id) {
        try {
          const p2 = await fetchPage(shareSite(cleaned.url, page.html) + '/x-p-' + id + '.html', UA_PREVIEW, left(), extra);
          if (classify(p2.html, p2.finalUrl) === 'ok') page = p2;
        } catch (e) { /* نكمل بما في صفحة المشاركة */ }
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

    const data = fromHtml(page.html, page.finalUrl);
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
