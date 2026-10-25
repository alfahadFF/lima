// netlify/functions/cj.js
// وسيط آمن بين صفحة "الفا" وواجهة CJ Dropshipping الرسمية.
// المفتاح السري CJ_API_KEY يتخزّن فقط بإعدادات Netlify (Environment variables).
const CJ = 'https://developers.cjdropshipping.com/api2.0/v1';
const SB_URL = process.env.SUPABASE_URL || 'https://gvbogfyfmkohepmukqmw.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2Ym9nZnlmbWtvaGVwbXVrcW13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxODU3NDksImV4cCI6MjEwNzc2MTc0OX0.A-84w91IS7XZbNlWRRBdXCpoMJFgcfGP8LKYdJqSNV0';

let tok = null; // كاش بالذاكرة: { accessToken, exp, refreshToken, refExp }

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

async function isSignedIn(authHeader) {
  if (!authHeader) return false;
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: authHeader } });
  return r.ok;
}

async function cjPost(path, body) {
  const r = await fetch(CJ + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 200) throw new Error(j.message || ('CJ error ' + j.code));
  return j.data;
}

function keepToken(d) {
  const now = Date.now();
  const t = Date.parse(d.accessTokenExpiryDate), rt = Date.parse(d.refreshTokenExpiryDate);
  tok = {
    accessToken: d.accessToken,
    exp: isNaN(t) ? now + 14 * 864e5 : t,
    refreshToken: d.refreshToken,
    refExp: isNaN(rt) ? now + 170 * 864e5 : rt
  };
}

async function getToken(force) {
  const now = Date.now();
  if (!force && tok && tok.exp - now > 36e5) return tok.accessToken;
  const apiKey = process.env.CJ_API_KEY;
  if (!apiKey) throw new Error('CJ_API_KEY غير مضبوط في إعدادات Netlify');
  if (tok && tok.refreshToken && tok.refExp - now > 36e5) {
    try { keepToken(await cjPost('/authentication/refreshAccessToken', { refreshToken: tok.refreshToken })); return tok.accessToken; } catch (e) { /* نطلب توكن جديد */ }
  }
  keepToken(await cjPost('/authentication/getAccessToken', { apiKey }));
  return tok.accessToken;
}

async function cjGet(path, params, retry = true) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(CJ + path + (qs ? '?' + qs : ''), { headers: { 'CJ-Access-Token': await getToken(!retry) } });
  const j = await r.json().catch(() => ({}));
  if (j.code === 1600001 && retry) { tok = null; return cjGet(path, params, false); }
  if (j.code !== 200) throw new Error(j.message || ('CJ error ' + j.code));
  return j.data;
}

const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

function search(data) {
  const out = [];
  (data.content || []).forEach(c => (c.productList || []).forEach(p => out.push({
    id: p.id, sku: p.sku || p.spu, name: p.nameEn, image: p.bigImage,
    price: p.nowPrice || p.sellPrice, stock: p.warehouseInventoryNum ?? null, freeShipping: p.addMarkStatus === 1
  })));
  return { items: out, page: data.pageNumber, totalPages: data.totalPages, total: data.totalRecords };
}

function splitOptions(p, v) {
  const keys = String(p.productKeyEn || '').split('-').map(s => s.trim().toLowerCase());
  const vals = String(v.variantKey || '').split('-').map(s => s.trim());
  let color = null, size = null;
  if (keys.length && keys.length === vals.length) {
    keys.forEach((k, i) => {
      if (/colou?r/.test(k)) color = vals[i];
      else if (/size/.test(k)) size = vals[i];
      else if (!color) color = vals[i];
      else size = size ? size + ' / ' + vals[i] : vals[i];
    });
  } else if (keys.length === 2 && /colou?r/.test(keys[0]) && /size/.test(keys[1]) && vals.length > 2) {
    size = vals[vals.length - 1];                 // لون من كلمتين مثل Light-Blue-M
    color = vals.slice(0, -1).join(' ');
  } else if (v.variantKey) size = v.variantKey;
  return { color, size };
}

function product(p) {
  const vs = (p.variants || []).map(v => {
    const o = splitOptions(p, v);
    const inv = Array.isArray(v.inventories) ? v.inventories.reduce((s, i) => s + (Number(i.totalInventory) || 0), 0) : null;
    return { vid: v.vid, sku: v.variantSku, key: v.variantKey, color: o.color, size: o.size, price: num(v.variantSellPrice), image: v.variantImage || null, stock: inv };
  });
  const prices = vs.map(v => v.price).filter(x => x != null);
  const imgs = [...new Set([].concat(p.productImageSet || [], p.bigImage ? [p.bigImage] : []))].slice(0, 10);
  const desc = String(p.description || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
  return {
    pid: p.pid, sku: p.productSku, name: p.productNameEn, description: desc, images: imgs,
    options: p.productKeyEn || '', price: prices.length ? Math.min(...prices) : num(p.sellPrice), variants: vs,
    stockKnown: vs.length > 0 && vs.every(v => v.stock != null)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return reply(405, { error: 'method not allowed' });
    const h = event.headers || {};
    if (!(await isSignedIn(h.authorization || h.Authorization))) return reply(401, { error: 'سجّل الدخول أولاً' });
    const q = event.queryStringParameters || {};
    if (q.action === 'search') {
      const kw = String(q.q || '').trim().slice(0, 100);
      if (!kw) return reply(400, { error: 'اكتب كلمة البحث' });
      const page = Math.min(1000, Math.max(1, parseInt(q.page, 10) || 1));
      return reply(200, search(await cjGet('/product/listV2', { page, size: 20, keyWord: kw })));
    }
    if (q.action === 'product') {
      if (!/^[\w-]{6,64}$/.test(q.pid || '')) return reply(400, { error: 'معرّف المنتج غير صالح' });
      return reply(200, product(await cjGet('/product/query', { pid: q.pid })));
    }
    return reply(400, { error: 'action غير معروف' });
  } catch (e) {
    return reply(502, { error: e.message || 'خطأ غير متوقع' });
  }
};
