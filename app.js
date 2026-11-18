// app.js - مشترك: اتصال Supabase، السلة، أدوات صغيرة
const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => CONFIG.CURRENCY + (Math.round(Number(n) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const empty = m => `<p class="empty">${esc(m)}</p>`;
const configReady = () => !/YOUR-/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_ANON_KEY);
// الصور: خلفية التحميل الرمادية من شي إن («SHEIN» على رمادي) ليست صورة منتج،
// وأي صورة ما تتحمل يظهر مكانها شعار واسم «ليمار ستور»
const isJunkImg = u => /\/she_dist\/images\/|\/bg-grey[-.]|placeholder/i.test(String(u || ''));
const NOIMG = '<span class="noimg-store" role="img" aria-label="ليمار ستور"><img src="icons/logo-mark.png" alt=""><b>ليمار ستور</b></span>';
function imgFail(el) { el.onerror = null; el.insertAdjacentHTML('afterend', NOIMG); el.remove(); }
const imgOf = list => (list || []).filter(i => i && !isJunkImg(i.url)).sort((a, b) => a.sort_order - b.sort_order)[0];
const img = (url, alt = '') => !url ? '' : isJunkImg(url) ? NOIMG
  : `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(String(url).split('#c=')[0])}" alt="${esc(alt)}" onerror="imgFail(this)">`;
// صورة لون معيّن: «رابط#c=لون|لون» ← { u: الرابط، colors: [الألوان] }
const dec = x => { try { return decodeURIComponent(x); } catch (e) { return x; } };
const imgTag = raw => { const [u, t] = String(raw || '').split('#c='); return { u, colors: t ? t.split('|').map(dec).filter(Boolean) : [] }; };

// وصف محفوظ من شي إن: بدون سعر شي إن وسياساتها، و«ليمار ستور» بدل شي إن (نفس منطق storeDesc في extract.js)
function storeDesc(d) {
  let s = String(d || '').replace(/[ \t]+/g, ' ').trim();
  if (!s) return '';
  if (/\|\s*SHEIN\b|Free\s+(shipping|returns)/i.test(s)) return '';
  s = s.replace(/I\s+(?:discovered|found)\s+(?:some\s+)?(?:amazing|great|awesome)\s+(?:products|items)\s+(?:on|at)\s+SHEIN(?:\.com)?\s*[,،]?\s*come\s+check\s+(?:them|it)\s+out\s*!?/gi,
    'اكتشفت منتجات رائعة في ليمار ستور، تعال وتحقق منها!');
  s = s.replace(/[^.!؟?\n]*(?:الدفع عند الاستلام|شحن مجاني|الشحن المجاني|إرجاع مجاني|الإرجاع المجاني)[^.!؟?\n]*[.!؟?]?/g, ' ');
  s = s.replace(/(^|[\s(])(?:في|على)\s+(?:SHEIN(?:\.com)?|شي\s?[إاأ]ن)(?!\s*ليمار)/gi, '$1في ليمار ستور')
    .replace(/(^|[\s(])من\s+(?:SHEIN(?:\.com)?|شي\s?[إاأ]ن)(?!\s*ليمار)/gi, '$1من ليمار ستور');
  return s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([،.!؟])/g, '$1').trim();
}

// السلة (localStorage مع احتياط بالذاكرة إذا كان التخزين ممنوعاً)
let memCart = [];
const Cart = {
  get() { try { return JSON.parse(localStorage.getItem('sl_cart') || '[]'); } catch (e) { return memCart; } },
  set(a) { memCart = a; try { localStorage.setItem('sl_cart', JSON.stringify(a)); } catch (e) {} renderBadge(); },
  add(it) { const a = this.get(); const f = a.find(x => x.variant_id === it.variant_id); if (f) f.qty = Math.min(f.qty + it.qty, 20); else a.push(it); this.set(a); },
  setQty(i, q) { const a = this.get(); if (q < 1) a.splice(i, 1); else a[i].qty = Math.min(q, 20); this.set(a); },
  clear() { this.set([]); },
  count() { return this.get().reduce((n, x) => n + x.qty, 0); },
  total() { return this.get().reduce((n, x) => n + x.qty * x.price, 0); }
};

function renderHeader() {
  const h = $('#hdr'); if (!h) return;
  h.innerHTML = `<div class="wrap bar"><a class="brand" href="index.html"><img class="logo" src="icons/logo-mark.png" alt="" width="40" height="40"><span>${esc(CONFIG.STORE_NAME)}</span></a>
    <div class="hbtns"><button class="cartlink icon" id="install" hidden aria-label="تثبيت التطبيق" title="تثبيت التطبيق"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg></button>
    <a class="cartlink" href="cart.html">السلة <span class="badge" id="badge" hidden></span></a></div></div>`;
  renderBadge(); renderInstall();
}

// تثبيت كتطبيق (أندرويد/كروم). على آيفون: مشاركة ثم "إضافة إلى الشاشة الرئيسية"
let deferredInstall = null;
function renderInstall() { const b = $('#install'); if (b) b.hidden = !deferredInstall; }
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; renderInstall(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; renderInstall(); });
document.addEventListener('click', async e => {
  if (e.target.id !== 'install' || !deferredInstall) return;
  deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; renderInstall();
});
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
function renderBadge() {
  const b = $('#badge'); if (!b) return;
  const n = Cart.count(); b.textContent = n; b.hidden = !n;
}
function toast(m) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = m; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, 3500);
}
