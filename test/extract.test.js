// test/extract.test.js — node test/extract.test.js
const fs = require('fs');
const path = require('path');
const { fromHtml, fromText, fromShare, cleanUrl, route } = require('../extract.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)); }
}
const ok = (name, cond, extra) => eq(name + (cond ? '' : ' — ' + (extra || '')), !!cond, true);
const fix = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

console.log('\n[1] شي إن — JSON-LD + حالة مدمجة');
{
  const r = fromHtml(fix('shein-jsonld.html'), 'https://www.shein.com/Floral-Print-Midi-Dress-p-12345678.html');
  eq('المصدر', r.source, 'shein');
  eq('العنوان من JSON-LD', r.title, 'SHEIN Frenchy Floral Print Midi Dress');
  eq('السعر', r.price, 18.5);
  eq('العملة', r.currency, 'USD');
  ok('ثلاث صور على الأقل', r.images.length >= 3, 'عدد=' + r.images.length);
  eq('إزالة لاحقة المصغّرة', r.images[0], 'https://img.ltwebstatic.com/images3_pi/2023/05/12/1a2b3c4d.jpg');
  ok('لا تكرار للصور', new Set(r.images).size === r.images.length);
  ok('الألوان', r.colors.includes('Pink') && r.colors.includes('Green'), JSON.stringify(r.colors));
  ok('المقاسات', r.sizes.includes('S') && r.sizes.includes('M'), JSON.stringify(r.sizes));
  ok('ثقة عالية', r.confidence === 'high', r.confidence);
  ok('وصف موجود', r.description.length > 5, r.description);
  ok('ok=true', r.ok === true);
}

console.log('\n[2] تيمو — window.rawData بلا JSON-LD');
{
  const r = fromHtml(fix('temu-rawdata.html'), 'https://www.temu.com/womens-sweatshirt-g-601099512345678.html');
  eq('المصدر', r.source, 'temu');
  ok('العنوان يحتوي Sweatshirt', /Sweatshirt/.test(r.title), r.title);
  eq('السعر مفضّلًا salePrice', r.price, 9.98);
  eq('العملة', r.currency, 'USD');
  ok('صورتان', r.images.length >= 2, 'عدد=' + r.images.length);
  eq('الوصف من meta', r.description, "Women's casual crew neck sweatshirt, soft fleece inside.");
  ok('ok=true', r.ok === true);
}

console.log('\n[3] وسوم meta فقط');
{
  const r = fromHtml(fix('meta-only.html'), 'https://www.shein.com/pants-p-999.html');
  eq('العنوان مع تنظيف | SHEIN', r.title, 'Linen Blend Wide Leg Pants');
  eq('السعر من meta', r.price, 12);
  eq('صورة واحدة', r.images.length, 1);
  ok('ثقة متوسطة أو أعلى', r.confidence === 'medium' || r.confidence === 'high', r.confidence);
}

console.log('\n[4] صفحة حجب / فارغة');
{
  const r = fromHtml('<html><body>Access Denied Reference #18.abc</body></html>', 'https://www.shein.com/x-p-1.html');
  eq('ok=false', r.ok, false);
  ok('توجد ملاحظات', r.notes.length > 0);
}

console.log('\n[5] تنظيف الروابط');
{
  eq('إزالة utm', cleanUrl('https://www.shein.com/dress-p-123.html?utm_source=app&utm_medium=share').url, 'https://www.shein.com/dress-p-123.html');
  eq('فك redirection', cleanUrl('https://www.shein.com/verify?redirection=' + encodeURIComponent('https://www.shein.com/dress-p-55.html')).url, 'https://www.shein.com/dress-p-55.html');
  eq('رابط غير صالح', cleanUrl('مرحبا'), null);
  eq('المصدر temu', cleanUrl('https://www.temu.com/x-g-1.html').source, 'temu');
}

console.log('\n[6] مدخلات غريبة لا تُسقط المحرّك');
{
  for (const html of ['', '<html>', '{"a":1}', '<script>var x = {bad json</script>']) {
    const r = fromHtml(html, 'https://www.shein.com/a-p-1.html');
    ok('لا يرمي استثناء', typeof r === 'object' && typeof r.ok === 'boolean');
  }
}


console.log('\n[7] الوضع النصي — نص منسوخ من متصفح الهاتف (إنجليزي)');
{
  const txt = [
    'SHEIN',
    "Women's Floral Print Midi Dress",
    'US$18.50',
    'US$29.00',
    '-36%',
    '4.8 (2341 reviews)',
    'Color: Pink',
    'Size: S M L XL',
    'Add to bag',
    'Floral print midi dress with tie waist and short sleeves, made of soft breathable fabric.',
    'Free shipping on orders over $29'
  ].join('\n');
  const r = fromText(txt, 'https://us.shein.com/x-p-123.html');
  eq('الوضع', r.mode, 'text');
  eq('العنوان', r.title, "Women's Floral Print Midi Dress");
  eq('السعر', r.price, 18.5);
  eq('العملة', r.currency, 'USD');
  eq('المقاسات كاملة', r.sizes, ['S', 'M', 'L', 'XL']);
  eq('لون واحد', r.colors, ['وردي']);
  ok('وصف', r.description.length > 40, r.description);
  ok('تنبيه بغياب الصور', r.notes.join(' ').includes('الصور'));
  eq('ok', r.ok, true);
}

console.log('\n[8] الوضع النصي — عربي بعملة ر.س');
{
  const txt = 'شي إن\nفستان صيفي طويل بالورود\nالسعر 45.00 ر.س\nمقاس: M L XL\nألوان: أسود، بيج\nفستان طويل بأكمام قصيرة وقماش قطني مريح مناسب للصيف.';
  const r = fromText(txt, 'https://ar.shein.com/x-p-9.html');
  eq('العنوان', r.title, 'فستان صيفي طويل بالورود');
  eq('السعر', r.price, 45);
  eq('العملة', r.currency, 'SAR');
  eq('المقاسات', r.sizes, ['M', 'L', 'XL']);
  eq('الألوان', r.colors, ['أسود', 'بيج']);
}

console.log('\n[9] الوضع النصي — مدخلات سيئة');
{
  eq('نص فارغ', fromText('', 'https://a.com').ok, false);
  const r = fromText('SHEIN\nتوصيل مجاني\n$0.00', 'https://a.com');
  eq('لا يرمي استثناء ويعطي ok=false', r.ok, false);
  eq('السعر صفر مرفوض', r.price, null);
  ok('يوجد تنبيهات', r.notes.length > 0);
}


console.log('\n[10] توجيه المدخلات (الخانة الواحدة)');
{
  eq('JSON', route('{"title":"x"}').kind, 'json');
  eq('رابط فقط', route('https://us.shein.com/a-p-1.html').kind, 'url');
  eq('رابط شي إن', route('https://us.shein.com/a-p-1.html').source, 'shein');
  eq('نص فقط', route('فستان صيفي جميل جدًا').kind, 'text');
  const pasted = 'SHEIN Women Dress\nUS$19.00\nSize: S M L\n' + 'وصف طويل '.repeat(40) + '\nhttps://us.shein.com/a-p-9.html';
  const r = route(pasted);
  eq('صفحة منسوخة كاملة', r.kind, 'url+text');
  eq('استخرج الرابط منها', r.url, 'https://us.shein.com/a-p-9.html');
  // والنتيجة النهائية: استخراج ناجح من النص نفسه
  const j = fromText(r.text, r.url);
  eq('عنوان من النص', j.title, 'SHEIN Women Dress');
  eq('سعر من النص', j.price, 19);
  eq('مقاسات', j.sizes, ['S', 'M', 'L']);
}


console.log('\n[11] لصق الرابط → رابط + اسم (بلا شبكة)');
{
  let r = fromShare('https://us.shein.com/Floral-Print-Midi-Dress-p-12345678.html?utm_source=app');
  eq('الرابط نظيف', r.url, 'https://us.shein.com/Floral-Print-Midi-Dress-p-12345678.html');
  eq('الاسم من الرابط', r.title, 'Floral Print Midi Dress');
  eq('المعرّف', r.id, '12345678');
  eq('المصدر', r.source, 'shein');

  r = fromShare('فستان ميدي بطبعات الزهور https://us.shein.com/Floral-Midi-Dress-p-12345678.html');
  eq('الاسم من نص المشاركة', r.title, 'فستان ميدي بطبعات الزهور');

  r = fromShare('https://www.shein.com/risk/challenge?redirection=' + encodeURIComponent('https://us.shein.com/Linen-Wide-Leg-Pants-p-99887766.html'));
  eq('يستخرج الرابط الأصلي من صفحة التحقق', r.url, 'https://us.shein.com/Linen-Wide-Leg-Pants-p-99887766.html');
  eq('اسمه', r.title, 'Linen Wide Leg Pants');

  r = fromShare('https://www.temu.com/g-607200982472092.html');
  eq('تيمو: رابط', r.url, 'https://www.temu.com/g-607200982472092.html');
  eq('تيمو: لا اسم وهمي', r.title, '');
  eq('تيمو: المعرّف', r.id, '607200982472092');

  eq('نص بلا رابط', fromShare('مرحبا'), null);
  ok('تنبيه أن الباقي يدوي', fromShare('https://us.shein.com/a-b-p-1.html') !== null);
}

console.log('\n' + (fail ? '❌ فشل ' + fail + ' / نجح ' + pass : '✅ كل الاختبارات ناجحة (' + pass + ')'));
process.exit(fail ? 1 : 0);
