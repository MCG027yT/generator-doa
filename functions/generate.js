export async function onRequestPost(context) {
  const { env, request } = context;
  const AUTPOST = env.AUTPOST_KV;
  const OVERLAY_API = env.OVERLAY_API_URL;

  async function kvGet(key) {
    try { return await AUTPOST.get(key); } catch { return null; }
  }

  function normalize(s) { return (s || "").trim().replace(/^[\s'"`]+|[\s'"`]+$/g, ""); }
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  async function runCFText(accountId, token, model, prompt) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
    });
    const j = await res.json().catch(() => ({}));
    return normalize(j?.result?.response || j?.output?.[0]?.content || "");
  }

  async function runCFImage(accountId, token, model, prompt) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const payload = { prompt, width: 1080, height: 1080 };
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.arrayBuffer();
  }

  // =====================================================
  // SISTEM ANTRIAN
  // =====================================================
  const ip = request.headers.get("CF-Connecting-IP") || crypto.randomUUID();
  const MAX_PARALLEL = 1;     // hanya 1 proses aktif
  const AVG_DURATION = 45;    // perkiraan detik per request
  const QUEUE_KEY = "QUEUE";
  const LOCK_KEY = "LOCK";

  const rawQ = await AUTPOST.get(QUEUE_KEY);
  let queue = rawQ ? JSON.parse(rawQ) : [];

  if (!queue.includes(ip)) {
    queue.push(ip);
    await AUTPOST.put(QUEUE_KEY, JSON.stringify(queue));
  }

  const position = queue.indexOf(ip) + 1;
  if (position > MAX_PARALLEL) {
    const estimate = (position - 1) * AVG_DURATION;
    return Response.json({
      status: "queue",
      message: `⏳ Kamu antre nomor ${position}. Perkiraan waktu tunggu ± ${estimate} detik.`,
      position,
      estimate,
    });
  }

  const isLocked = await AUTPOST.get(LOCK_KEY);
  if (isLocked) {
    const estimate = AVG_DURATION;
    return Response.json({
      status: "queue",
      message: `⚠️ Server sedang memproses permintaan lain. Perkiraan tunggu ± ${estimate} detik.`,
      position,
      estimate,
    });
  }

  await AUTPOST.put(LOCK_KEY, "1", { expirationTtl: AVG_DURATION + 15 });

  // =====================================================
  // PROSES UTAMA GENERATE
  // =====================================================
  const formData = await request.formData();
  let kata = formData.get("kata")?.trim();
  const gambar = formData.get("gambar");

  const CF_ACCOUNT_ID = await kvGet("cf_AkunID");
  const CF_TOKEN = await kvGet("cf_token");
  const MODEL_TXT = (await kvGet("model_txt")) || "@cf/meta/llama-3-8b-instruct";
  const MODEL_IMG = (await kvGet("model_img")) || "@cf/stabilityai/stable-diffusion-xl-base-1.0";

  if (!kata) {
    const raw = await kvGet("kata_kunci");
    const list = raw ? raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : [];
    kata = list.length ? list[Math.floor(Math.random() * list.length)] : "Doa Harian";
  }

  const caption = await runCFText(CF_ACCOUNT_ID, CF_TOKEN, MODEL_TXT,
  `Tuliskan satu kalimat pendek doa Islami yang indah, lembut, dan bermakna dari kata kunci "${kata}". Jangan beri penjelasan atau tanda baca aneh.`
);

const tags = await runCFText(CF_ACCOUNT_ID, CF_TOKEN, MODEL_TXT,
  `Buat maksimal 5 tagar pendek relevan (tanpa simbol #), pisahkan dengan spasi, dari kalimat doa berikut: "${caption}". Hanya keluarkan tagarnya saja.`
);

const arab = await runCFText(CF_ACCOUNT_ID, CF_TOKEN, MODEL_TXT,
  `Tulis doa pendek dalam bahasa Arab lengkap dengan harakat berdasarkan kata kunci "${kata}". Jangan beri terjemahan, catatan, atau tanda kurung. Hanya teks Arab-nya saja.`
);

const indo = await runCFText(CF_ACCOUNT_ID, CF_TOKEN, MODEL_TXT,
  `Terjemahkan ke Bahasa Indonesia yang halus dan singkat teks Arab berikut:\n\n${arab}\n\nTampilkan hanya hasil terjemahan tanpa tambahan apapun.`
);

  let rawImgBase64 = "";
  if (gambar && gambar.name) {
    const buf = await gambar.arrayBuffer();
    rawImgBase64 = arrayBufferToBase64(buf);
  } else {
    const buf = await runCFImage(CF_ACCOUNT_ID, CF_TOKEN, MODEL_IMG,
      `Photorealistic HD illustration of: ${kata}, no humans, beautiful, natural light`
    );
    rawImgBase64 = arrayBufferToBase64(buf);
  }

  const overlayRes = await fetch(OVERLAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64: rawImgBase64, title: kata, arab, indo }),
  });
  const j = await overlayRes.json().catch(() => ({}));

  // =====================================================
  // SELESAI PROSES → LEPAS LOCK & ANTRIAN
  // =====================================================
  await AUTPOST.delete(LOCK_KEY);
  queue = queue.filter(x => x !== ip);
  await AUTPOST.put(QUEUE_KEY, JSON.stringify(queue));

  // =====================================================
  // RESPON AKHIR
  // =====================================================
  return Response.json({
    status: "done",
    kata,
    caption,
    tags,
    arab,
    indo,
    final_base64: j.final_base64 || rawImgBase64,
  });
}
