// netlify/functions/import-product.js
// جلب صفحة منتج من شي إن / تيمو ومحاولة استخراج بياناتها — بلا أي خدمة مدفوعة.
//
// ما يمكن وما لا يمكن (مُختبر فعليًا لا نظريًا):
//   • شي إن: أي طلب من خادم يتحوّل إلى صفحة تحقق  /risk/challenge?captcha_type=909
//            لذلك الجلب الآلي لا يعمل مجانًا — نُبلّغ بذلك بصراحة ونجهّز البديل.
//   • تيمو : الصفحة تُرجع العنوان ووسوم meta، لكن السعر والألوان تُحمّل بالجافاسكربت
//            لذلك نحصل على استخراج جزئي مفيد (اسم + صورة + وصف).
//
// الطريقان المجانيان المضمونان هما في الواجهة: زر السحب (من متصفحك) ولصق نص الصفحة.
// إن قرّرت لاحقًا استخدام خدمة تجاوز حجب، أضف طبقة واحدة هنا قبل fetchDirect — لا حاجة لأي تغيير آخر.

const { fromHtml, cleanUrl, sourceOf } = require('../../extract.js');

// مفتاح anon علني بطبيعته (نفسه الموجود في config.js) — يُستخدم فقط للتحقق من جلسة الأدمن.
const SB_URL = process.env.SUPABASE_URL || 'https://gvbogfyfmkohepmukqmw.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2Ym9nZnlmbWtvaGVwbXVrcW13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxODU3NDksImV4cCI6MjEwNzc2MTc0OX0.A-84w91IS7XZbNlWRRBdXCpoMJFgcfGP8LKYdJqSNV0';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

async function fetchPage(target) {
  const r = await timedFetch(target, {
    headers: {
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
    }
  }, 20000);
  return { status: r.status, html: await r.text(), finalUrl: r.url || target };
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
    if (!/^https:/.test(cleaned.url)) return reply(400, { error: 'الرابط يجب أن يكون https' });

    const src = sourceOf(cleaned.url);
    let page;
    try {
      page = await fetchPage(cleaned.url);
    } catch (e) {
      return reply(200, {
        ok: false, blocked: true, reason: 'network', source: src, url: cleaned.url,
        error: 'تعذّر الوصول إلى الموقع من الخادم',
        reasons: [e.name === 'AbortError' ? 'انتهت المهلة (20 ثانية)' : e.message],
        hint: HINTS.challenge
      });
    }

    const kind = classify(page.html, page.finalUrl);
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
