// 只開放台灣 IP：cf.country 沒有值(如本機開發)就放行，避免擋掉自己測試。
export async function onRequest(context) {
  const country = context.request.cf?.country;
  if (country && country !== "TW") {
    return new Response("Forbidden", { status: 403 });
  }
  return context.next();
}
