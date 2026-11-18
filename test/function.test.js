// test/function.test.js — node test/function.test.js
// يختبر دالة Netlify كاملة مع تعويض الشبكة (fetch) بدل الاتصال الحقيقي.
const fs = require('fs');
const path = require('path');
const { handler } = require('../netlify/functions/import-product.js');

const fix = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
let pass = 0, fail = 0;
const eq = (n, g, w) => {
  if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + '\n      got:  ' + JSON.stringify(g) + '\n      want: ' + JSON.stringify(w)); }
};
const ok = (n, c, x) => eq(n + (c ? '' : ' — ' + (x || '')), !!c, true);

const realFetch = global.fetch;
let pageHtml = null;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/auth/v1/user')) return new Response('{"id":"u1"}', { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(pageHtml ?? '', { status: 200, headers: { 'content-type': 'text/html' } });
};

const call = (qs, headers = { authorization: 'Bearer tok' }) =>
  handler({ httpMethod: 'GET', headers, queryStringParameters: qs }).then(r => ({ status: r.statusCode, body: JSON.parse(r.body) }));

(async () => {
  console.log('\n[1] جلب ناجح من شي إن');
  pageHtml = fix('shein-jsonld.html');
  let r = await call({ url: 'https://www.shein.com/Floral-Print-Midi-Dress-p-12345678.html?utm_source=app' });
  eq('الحالة', r.status, 200);
  eq('ok', r.body.ok, true);
  eq('العنوان', r.body.title, 'SHEIN Frenchy Floral Print Midi Dress');
  eq('السعر', r.body.price, 18.5);
  eq('الطريقة', r.body.via, 'direct');
  ok('صور', r.body.images.length >= 3, r.body.images.length);
  eq('صفحة نظيفة (utm محذوف)', r.body.url, 'https://www.shein.com/Floral-Print-Midi-Dress-p-12345678.html');

  console.log('\n[2] تيمو');
  pageHtml = fix('temu-rawdata.html');
  r = await call({ url: 'https://www.temu.com/womens-sweatshirt-g-601099512345678.html' });
  eq('ok', r.body.ok, true);
  eq('السعر', r.body.price, 9.98);

  console.log('\n[3] شي إن: صفحة تحقق بشري (الواقع المُختبر)');
  pageHtml = '<html><head><title>Security verification</title></head><body><div id="captcha"></div> please verify you are a human </body></html>';
  r = await call({ url: 'https://us.shein.com/x-p-1.html' });
  eq('الحالة', r.status, 200);
  eq('ok=false', r.body.ok, false);
  eq('blocked=true', r.body.blocked, true);
  eq('السبب', r.body.reason, 'challenge');
  ok('رسالة تشرح أنه ليس خطأه', /ليس خطأ/.test(r.body.hint || ''), r.body.hint);
  ok('توجيه لزر السحب', /زر السحب/.test(r.body.hint || ''));

  console.log('\n[3ب] تحويل إلى مسار risk/challenge');
  const realFetch2 = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return new Response('{}', { status: 200 });
    return new Response('<html><body>' + 'x'.repeat(900) + '</body></html>', { status: 200 });
  };
  const origClassifyUrl = 'https://us.shein.com/risk/challenge?captcha_type=909&redirection=x';
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return new Response('{}', { status: 200 });
    return { ok: true, status: 200, url: origClassifyUrl, text: async () => '<html><body>' + 'x'.repeat(900) + '</body></html>' };
  };
  r = await call({ url: 'https://us.shein.com/x-p-1.html' });
  eq('يُصنّف تحققًا', r.body.reason, 'challenge');
  global.fetch = realFetch2;

  console.log('\n[3ج] تيمو: استخراج جزئي (بلا سعر)');
  pageHtml = '<html><head><title>headboard backrest cushion - Temu</title>'
    + '<meta property="og:title" content="Headboard Backrest Cushion"><meta name="description" content="Adjustable memory foam cushion for bed."></head><body>'
    + 'x'.repeat(600) + '</body></html>';
  r = await call({ url: 'https://www.temu.com/g-607200982472092.html' });
  eq('ok=true', r.body.ok, true);
  eq('جزئي', r.body.partial, true);
  ok('يذكر نقص السعر', /السعر/.test(r.body.error || ''), r.body.error);

  console.log('\n[4] حماية الواجهة');
  r = await call({ url: 'https://www.shein.com/x-p-1.html' }, {});
  eq('بدون توثيق → 401', r.status, 401);
  r = await call({ url: 'مرحبا' });
  eq('رابط غير صالح → 400', r.status, 400);
  r = await call({});
  eq('بلا رابط → 400', r.status, 400);
  const post = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, queryStringParameters: {} });
  eq('POST → 405', post.statusCode, 405);

  console.log('\n[5] فشل الشبكة لا يُسقط الدالة');
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return new Response('{}', { status: 200 });
    throw new Error('ENOTFOUND');
  };
  r = await call({ url: 'https://www.shein.com/x-p-1.html' });
  eq('يرجع 200 مع ok=false', [r.status, r.body.ok], [200, false]);
  ok('سبب الشبكة مذكور', (r.body.reasons || []).join(' ').includes('ENOTFOUND'), JSON.stringify(r.body.reasons));


  console.log('\n[6] شي إن: بصمة معاينة الروابط أولًا، ثم كروم كاحتياط');
  {
    const seen = [];
    global.fetch = async (url, opts) => {
      if (String(url).includes('/auth/v1/user')) return new Response('{}', { status: 200 });
      seen.push(opts.headers['User-Agent']); seen.cookie = opts.headers.Cookie;
      return new Response(fix('shein-productgroup.html'), { status: 200 });
    };
    r = await call({ url: 'https://ar.shein.com/x-p-28052129.html' });
    eq('يطلب السعر بالدولار', seen.cookie, 'currency=USD');
    eq('أول طلب ببصمة المعاينة', seen[0], 'Twitterbot/1.0');
    eq('طلب واحد يكفي', seen.length, 1);
    eq('ok', r.body.ok, true);
    eq('ليس جزئيًا', r.body.partial, undefined);
    ok('مقاسات وألوان', r.body.sizes.length === 4 && r.body.colors.length === 1, JSON.stringify([r.body.sizes, r.body.colors]));

    seen.length = 0;
    global.fetch = async (url, opts) => {
      if (String(url).includes('/auth/v1/user')) return new Response('{}', { status: 200 });
      const ua = opts.headers['User-Agent']; seen.push(ua);
      if (ua === 'Twitterbot/1.0') return { ok: true, status: 200, url: 'https://us.shein.com/risk/challenge?captcha_type=909', text: async () => 'x'.repeat(900) };
      return new Response(fix('shein-jsonld.html'), { status: 200 });
    };
    r = await call({ url: 'https://us.shein.com/x-p-12345678.html' });
    eq('محاولتان (معاينة ثم كروم)', seen.length, 2);
    eq('ok عبر كروم', r.body.ok, true);

    seen.length = 0;
    global.fetch = async (url, opts) => {
      if (String(url).includes('/auth/v1/user')) return new Response('{}', { status: 200 });
      seen.push(opts.headers['User-Agent']);
      return new Response(fix('temu-rawdata.html'), { status: 200 });
    };
    r = await call({ url: 'https://www.temu.com/womens-sweatshirt-g-601099512345678.html' });
    ok('تيمو بلا تغيير (كروم فقط)', seen.length === 1 && seen[0] !== 'Twitterbot/1.0', JSON.stringify(seen));
  }

  console.log('\n[7] روابط المشاركة من تطبيق شي إن (صفحات حقيقية محفوظة) → صفحة المنتج الكاملة');
  {
    const gone = '<html><head><title>[goods_name] | SHEIN USA</title></head><body>' + 'x'.repeat(900) + '</body></html>';
    let asked = [];
    const mock = (arHas = true) => async (url, opts) => {
      const u = String(url);
      if (u.includes('/auth/v1/user')) return new Response('{}', { status: 200 });
      asked.push(u);
      if (u.startsWith('https://onelink.shein.com/')) return new Response(fix('shein-onelink.html'), { status: 200 });
      if (u.includes('/h5/sharejump/appjump')) return new Response(fix('shein-appjump.html'), { status: 200 });
      if (u === 'https://ar.shein.com/x-p-77417590.html') return new Response(arHas ? fix('shein-productgroup.html') : gone, { status: 200 });
      if (u === 'https://us.shein.com/x-p-77417590.html') return new Response(fix('shein-productgroup.html'), { status: 200 });
      return new Response(gone, { status: 200 });
    };

    // ① رسالة onelink كما ينسخها التطبيق (اسم طويل + جملة + رابط)
    global.fetch = mock(); asked = [];
    r = await call({ url: 'Rom&nd JUICY Long-Lasting Lip Glaze 12 Cherry Bomb, Breathable Hydrating Film Fusion I discovered amazing products on SHEIN.com, come check them out! https://onelink.shein.com/58/66o0szw7pv1q?shc=2_RsXvL2FkE4k' });
    eq('onelink: طلب الرابط ثم صفحة المنتج بالرقم من deeplink', asked, ['https://onelink.shein.com/58/66o0szw7pv1q?shc=2_RsXvL2FkE4k', 'https://ar.shein.com/x-p-77417590.html']);
    eq('ok', r.body.ok, true);
    eq('ليس جزئيًا', r.body.partial, undefined);
    ok('صور كثيرة لا صورة واحدة', r.body.images.length >= 5, r.body.images.length);
    ok('السعر موجود', r.body.price != null, r.body.price);
    ok('مقاسات', r.body.sizes.length === 4, JSON.stringify(r.body.sizes));

    // ② رابط appjump القديم (http) → shareInfo.id (shareType 8)
    global.fetch = mock(); asked = [];
    r = await call({ url: 'http://api-shein.shein.com/h5/sharejump/appjump?link=RsXvL2FkE4k_8&localcountry=TW&url_from=GM74806974455' });
    ok('appjump بـ https', /^https:\/\/api-shein\.shein\.com\/h5\/sharejump\/appjump/.test(asked[0] || ''), asked[0]);
    eq('appjump: صفحة المنتج بالرقم من shareInfo.id', asked[1], 'https://ar.shein.com/x-p-77417590.html');
    eq('ok كامل', [r.body.ok, r.body.partial], [true, undefined]);

    // ③ المنتج غير متوفر في الموقع العربي → الأمريكي
    global.fetch = mock(false); asked = [];
    r = await call({ url: 'https://onelink.shein.com/58/66o0szw7pv1q?shc=2_RsXvL2FkE4k' });
    eq('ثم us.shein.com', asked.slice(1), ['https://ar.shein.com/x-p-77417590.html', 'https://us.shein.com/x-p-77417590.html']);
    eq('ok', r.body.ok, true);

    // ④ صفحة مشاركة بلا رقم منتج → ما فيها (جزئي) كما كان
    global.fetch = async (url) => {
      if (String(url).includes('/auth/v1/user')) return new Response('{}', { status: 200 });
      return new Response('<html><head><meta property="og:title" content="Heart Necklace Pendant"><meta property="og:image" content="https://img.ltwebstatic.com/images3_spmp/2024/10/16/b2/y.jpg"></head><body>' + 'x'.repeat(800) + '</body></html>', { status: 200 });
    };
    r = await call({ url: 'https://onelink.shein.com/1/zz' });
    eq('بلا رقم منتج → جزئي', [r.body.ok, r.body.partial], [true, true]);
  }


  console.log('\n[8] كل خيار بسعره: النقشات الأخرى (منتجات مستقلة) تُجلب ويُضاف سعر كل خيار');
  {
    let asked = [], failB = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/auth/v1/user')) return new Response('{}', { status: 200 });
      asked.push([u, opts.headers['User-Agent'], opts.headers.Cookie]);
      if (u === 'https://ar.shein.com/x-p-453530243.html') return new Response(fix('shein-ar-pattern-a.html'), { status: 200 });
      if (u === 'https://ar.shein.com/x-p-453108758.html') { if (failB) throw new Error('timeout'); return new Response(fix('shein-ar-pattern-b.html'), { status: 200 }); }
      return new Response('', { status: 404 });
    };
    r = await call({ url: 'https://ar.shein.com/x-p-453530243.html' });
    eq('جلب النقشة الثانية', asked.map(a => a[0]), ['https://ar.shein.com/x-p-453530243.html', 'https://ar.shein.com/x-p-453108758.html']);
    eq('ببصمة المعاينة وبالدولار', [asked[1][1], asked[1][2]], ['Twitterbot/1.0', 'currency=USD']);
    eq('نقشتان وصلتا', r.body.patterns, { total: 2, priced: 2 });
    eq('4 خيارات بأسعارها ومخزونها', r.body.skus.map(v => [v.color, v.size, v.price, v.inStock]), [
      ['متعدد الألوان', null, 13.18, true], ['قطعتين (رمادي ذهبي + شاي ذهبي)', null, 15.17, true],
      ['أوراق الشاي بإطار ذهبي', null, 10.11, false], ['إطار فضي قطعة رمادية', null, 10.11, true]]);
    eq('الألوان = أسماء الخيارات', r.body.colors.length, 4);
    eq('صورة كل نقشة لخياراتها', Object.keys(r.body.colorImages), ['متعدد الألوان', 'قطعتين (رمادي ذهبي + شاي ذهبي)', 'أوراق الشاي بإطار ذهبي', 'إطار فضي قطعة رمادية']);
    ok('صورتان مختلفتان (نقشة لكل صورة)', new Set(Object.values(r.body.colorImages)).size === 2 && r.body.colorImages['أوراق الشاي بإطار ذهبي'] === r.body.colorImages['إطار فضي قطعة رمادية'], JSON.stringify(r.body.colorImages));
    ok('الصور بالحجم الكامل (بدون _thumbnail_405x552)', Object.values(r.body.colorImages).every(u => /^https:\/\/img\.ltwebstatic\.com\//.test(u) && !/thumbnail_405x552/.test(u)), JSON.stringify(r.body.colorImages));
    eq('التصنيف يوصل للوحة', r.body.categories.map(n => n.name), ['ملابس واكسسوارات', 'اكسسوارات نسائية', 'نظارات نسائية وإكسسوارات نظارات', 'نظارات شمسية نسائية']);
    eq('السعر الأساسي = النقشة المشارَكة', r.body.price, 13.18);

    asked = []; failB = true;
    r = await call({ url: 'https://ar.shein.com/x-p-453530243.html' });
    eq('نقشة ما وصلت ← ما تنضاف بسعر غلط', [r.body.ok, r.body.patterns, r.body.skus.length], [true, { total: 2, priced: 1 }, 1]);
    eq('…ولا صورة ألوان لنقشة وحدة', r.body.colorImages, undefined);

    asked = [];
    global.fetch = async (url) => {
      if (String(url).includes('/auth/v1/user')) return new Response('{}', { status: 200 });
      asked.push(String(url));
      return new Response(fix('shein-productgroup.html'), { status: 200 });
    };
    r = await call({ url: 'https://us.shein.com/x-p-28052129.html' });
    eq('نقشة واحدة ← بلا جلب إضافي', asked.length, 1);
    eq('المقاسات بأسعارها', r.body.skus.map(v => [v.color, v.size, v.price]), [['Khaki', 'XL', 63.08], ['Khaki', 'L', 63.08], ['Khaki', 'M', 63.08], ['Khaki', 'S', 63.08]]);
  }

  global.fetch = realFetch;
  console.log('\n' + (fail ? '❌ فشل ' + fail + ' / نجح ' + pass : '✅ كل الاختبارات ناجحة (' + pass + ')'));
  process.exit(fail ? 1 : 0);
})();
