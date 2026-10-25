// config.js - مشترك بين كل الصفحات
window.CONFIG = {
  SUPABASE_URL: "https://gvbogfyfmkohepmukqmw.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2Ym9nZnlmbWtvaGVwbXVrcW13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxODU3NDksImV4cCI6MjEwNzc2MTc0OX0.A-84w91IS7XZbNlWRRBdXCpoMJFgcfGP8LKYdJqSNV0",
  WHATSAPP_NUMBER: "963998747936", // رقمك اللي بيستقبل الطلبات، بصيغة دولية بدون + أو 00
  CURRENCY: "$",
  STORE_NAME: "شي ان ليمار ستور",
  DELIVERY_NOTE: "", // مثال: مدة التوصيل المتوقعة. اتركه فارغاً لإخفائه
  CART_NOTE: "السعر النهائي وتكلفة الشحن نؤكدها معك على واتساب."
};

// بناء رابط واتساب للسلة: كود المنتج + لون/مقاس + كمية + سعر
window.buildWhatsAppLink = function (items, customer) {
  const lines = ["طلب جديد:", ""];
  let total = 0;
  items.forEach((it, i) => {
    const sub = it.price * it.qty;
    total += sub;
    lines.push(
      `${i + 1}) كود: ${it.code}` +
      (it.color ? ` | اللون: ${it.color}` : "") +
      (it.size ? ` | المقاس: ${it.size}` : "") +
      ` | الكمية: ${it.qty} | ${sub}${CONFIG.CURRENCY}`
    );
  });
  lines.push("", `الإجمالي: ${total}${CONFIG.CURRENCY}`);
  if (customer) {
    lines.push("", `الاسم: ${customer.name}`, `المدينة: ${customer.city}`);
  }
  return `https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join("\n"))}`;
};
