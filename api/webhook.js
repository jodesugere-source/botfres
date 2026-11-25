/**
 * FREEPACK BOT v2: bot Telegram bagi-bagi pack GRATIS, fitur admin dibuat mirip bot utama
 * (/tambah, /tambahfile, /setpreview, /previewmassal, /postset, /postsemua, /tandaipost, auto-post set baru).
 * Hosting: Vercel Hobby (gratis) • Database: Upstash Redis (free) • File disimpan di Telegram (file_id)
 *
 * ENV (Vercel > Settings > Environment Variables):
 *   BOT_TOKEN, BOT_USERNAME (tanpa @), ADMIN_IDS (id Telegram admin, pisah koma)
 *   CHANNEL                 @usernamechannel (bot harus admin channel). Channel privat: id -100xxx + JOIN_URL
 *   JOIN_URL                (opsional) link join kalau CHANNEL berupa id
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   WEBHOOK_SECRET          string acak (huruf/angka) untuk setWebhook
 *   DAILY_LIMIT             batas ambil pack per user/hari (default 5, 0 = tanpa batas)
 *   POST_PER_DAY            batas posting ke channel per hari (default 0 = tanpa batas)
 *   POST_MAX_PER_RUN        maks posting per proses (default 15, sisanya lanjut otomatis)
 *   PROTECT                 "0" = file boleh di-forward/save (default: tidak boleh)
 *   FORCE_JOIN              "0" = tidak wajib join channel (default: wajib)
 *   KEY_PREFIX              (opsional) awalan key Redis, default "fp:"
 *
 * Pasang webhook (sekali):
 *   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<project>.vercel.app/api/webhook&secret_token=<WEBHOOK_SECRET>
 *
 * ADMIN (chat pribadi ke bot). Ketik /help untuk daftar lengkap. NOMOR = nomor set (tetap, tidak bergeser kalau ada yang dihapus).
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMINS = (process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const CHANNEL = process.env.CHANNEL || "";
const DAILY_LIMIT = process.env.DAILY_LIMIT === undefined ? 5 : Number(process.env.DAILY_LIMIT);
const POST_PER_DAY = Number(process.env.POST_PER_DAY || 0);
const MAX_RUN = Number(process.env.POST_MAX_PER_RUN || 15);
const PROTECT = process.env.PROTECT !== "0";
const FORCE_JOIN = process.env.FORCE_JOIN !== "0" && !!CHANNEL;

const URL_RE = /https?:\/\/[^\s<>"]+/g;
const isAdmin = (uid) => ADMINS.includes(String(uid));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // WIB

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
const KEY_PREFIX = process.env.KEY_PREFIX || "fp:"; // semua key Redis diawali ini, jadi aman walau satu database dengan bot lain
async function rd(...cmd) {
  cmd[1] = KEY_PREFIX + cmd[1];
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const send = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

// kirim teks panjang (dipecah per ~3800 karakter)
async function sendLong(chat, lines) {
  let cur = "";
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > 3800) {
      await send(chat, cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + l;
  }
  if (cur) await send(chat, cur);
}

function mediaOf(m) {
  if (m.photo) return { t: "photo", id: m.photo[m.photo.length - 1].file_id };
  if (m.video) return { t: "video", id: m.video.file_id };
  if (m.document) return { t: "document", id: m.document.file_id };
  return null;
}
const normUrl = (u) => (/^(t\.me|telegram\.me)\//i.test(u) ? "https://" + u : u);

// "1,2,3" / "5-9" / "1 4 7-10" -> [1,2,3,...]
function parseNos(str) {
  const out = new Set();
  for (const tok of String(str).split(/[\s,]+/).filter(Boolean)) {
    const rg = /^(\d+)-(\d+)$/.exec(tok);
    if (rg) {
      let a = +rg[1], b = +rg[2];
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b && n - a <= 1000; n++) out.add(n);
    } else if (/^\d+$/.test(tok)) out.add(+tok);
  }
  return [...out].sort((a, b) => a - b);
}

async function getPack(id) {
  const raw = await rd("HGET", "packs", String(id));
  return raw ? JSON.parse(raw) : null;
}
const savePack = (p) => rd("HSET", "packs", String(p.id), JSON.stringify(p));
async function getPacks() {
  const flat = (await rd("HGETALL", "packs")) || [];
  const out = [];
  for (let i = 1; i < flat.length; i += 2) out.push(JSON.parse(flat[i]));
  return out.sort((a, b) => a.id - b.id);
}
async function hashMap(key) {
  const flat = (await rd("HGETALL", key)) || [];
  const m = {};
  for (let i = 0; i < flat.length; i += 2) m[flat[i]] = flat[i + 1];
  return m;
}
const total = (p) => (p.files || []).length + (p.links || []).length;

// ---------- POSTING KE CHANNEL ----------
async function postPack(p) {
  if (!CHANNEL) return { ok: false, reason: "CHANNEL belum diisi" };
  if (!p.preview) return { ok: false, reason: "tanpa preview" };
  const caption =
    `🆕 <b>SET BARU RILIS!</b>\n\n📦 <b>${esc(p.nama)}</b>\n` +
    (p.creator ? `👤 Creator: ${esc(p.creator)}\n` : "") +
    `📂 Isi: ${esc(p.isi)}\n🎁 <b>GRATIS</b>\n\nKlik tombol di bawah buat lihat & ambil lewat bot 👇`;
  const reply_markup = { inline_keyboard: [[{ text: "🎁 Lihat & Ambil", url: `https://t.me/${process.env.BOT_USERNAME}?start=p${p.id}` }]] };
  const r = await tg("sendPhoto", { chat_id: CHANNEL, photo: p.preview, caption, parse_mode: "HTML", reply_markup });
  if (r.ok) {
    await rd("HSET", "posted", String(p.id), "1");
    return { ok: true };
  }
  return { ok: false, reason: r.description || "gagal kirim" };
}

// antrean posting: dipakai /postset & /postsemua, diproses bertahap tiap ada pesan masuk
async function enqueue(ids, force) {
  const inQ = new Set(((await rd("LRANGE", "pq", 0, -1)) || []).map(String));
  const posted = await hashMap("posted");
  const packs = new Set((await getPacks()).map((p) => String(p.id)));
  let added = 0, sudah = 0, tidakAda = 0;
  for (const n of ids) {
    const id = String(n);
    if (!packs.has(id)) { tidakAda++; continue; }
    if (posted[id]) {
      if (!force) { sudah++; continue; }
      await rd("HDEL", "posted", id);
    }
    if (inQ.has(id)) continue;
    await rd("RPUSH", "pq", id);
    added++;
  }
  return { added, sudah, tidakAda };
}

async function runBatch() {
  if (!CHANNEL || !(await rd("LLEN", "pq"))) return;
  if (!(await rd("SET", "pq:lock", "1", "NX", "EX", 90))) return;
  try {
    let posted = 0;
    const skipped = [], failed = [];
    while (posted + skipped.length + failed.length < MAX_RUN) {
      const dk = `pc:${today()}`;
      if (POST_PER_DAY > 0 && (Number(await rd("GET", dk)) || 0) >= POST_PER_DAY) break;
      const id = await rd("LPOP", "pq");
      if (!id) break;
      if (await rd("HEXISTS", "posted", String(id))) continue;
      const p = await getPack(id);
      if (!p) continue;
      const r = await postPack(p);
      if (r.ok) {
        posted++;
        if (POST_PER_DAY > 0 && (await rd("INCR", dk)) === 1) await rd("EXPIRE", dk, 172800);
        await sleep(1000);
      } else if (r.reason === "tanpa preview") skipped.push(id);
      else failed.push(`${id} (${r.reason})`);
    }
    const left = await rd("LLEN", "pq");
    if ((posted || skipped.length || failed.length) && ADMINS[0]) {
      await send(
        ADMINS[0],
        `📢 <b>Posting ke channel</b>\n✅ Terkirim: ${posted}` +
          (skipped.length ? `\n⏭ Dilewati (belum ada preview): ${skipped.join(", ")} → pasang dengan /setpreview lalu /postset` : "") +
          (failed.length ? `\n❌ Gagal: ${esc(failed.join("; "))}` : "") +
          `\n${left ? `⏳ Sisa antrean: ${left} (lanjut otomatis)` : "🎉 Antrean kosong."}`
      );
    }
  } finally {
    await rd("DEL", "pq:lock");
  }
}

// ---------- KIRIM PACK KE USER ----------
async function isMember(uid) {
  const r = await tg("getChatMember", { chat_id: CHANNEL, user_id: uid });
  if (!r.ok) return false;
  const s = r.result.status;
  return ["member", "administrator", "creator"].includes(s) || (s === "restricted" && r.result.is_member);
}

async function deliver(uid, chat, id) {
  const pack = await getPack(id);
  if (!pack) return send(chat, "😕 Set tidak ditemukan atau sudah dihapus. Ketik /katalog untuk lihat daftar.");

  if (FORCE_JOIN && !isAdmin(uid) && !(await isMember(uid))) {
    const joinUrl = process.env.JOIN_URL || `https://t.me/${CHANNEL.replace("@", "")}`;
    return send(chat, "🔒 Join channel dulu ya, habis itu tekan <b>Sudah join</b>.", {
      reply_markup: { inline_keyboard: [[{ text: "📢 Join Channel", url: joinUrl }], [{ text: "✅ Sudah join", callback_data: `get:${id}` }]] },
    });
  }
  const files = pack.files || [];
  const links = pack.links || [];
  if (!files.length && !links.length) return send(chat, "⏳ Isi set ini belum diunggah admin. Coba lagi nanti ya.");

  if (DAILY_LIMIT > 0 && !isAdmin(uid)) {
    const key = `lim:${uid}:${today()}`;
    const used = Number(await rd("GET", key)) || 0;
    if (used >= DAILY_LIMIT) return send(chat, `⏳ Batas ambil hari ini (${DAILY_LIMIT} set) sudah habis. Coba lagi besok ya.`);
    if ((await rd("INCR", key)) === 1) await rd("EXPIRE", key, 172800);
  }

  await send(chat, `📦 Mengirim <b>${esc(pack.nama)}</b>...`);
  const chunk = (a) => Array.from({ length: Math.ceil(a.length / 10) }, (_, i) => a.slice(i * 10, i * 10 + 10));
  const vis = files.filter((f) => f.t !== "document");
  const docs = files.filter((f) => f.t === "document");
  for (const g of chunk(vis)) {
    if (g.length === 1) await tg(g[0].t === "photo" ? "sendPhoto" : "sendVideo", { chat_id: chat, [g[0].t]: g[0].id, protect_content: PROTECT });
    else await tg("sendMediaGroup", { chat_id: chat, media: g.map((f) => ({ type: f.t, media: f.id })), protect_content: PROTECT });
    await sleep(500);
  }
  for (const g of chunk(docs)) {
    if (g.length === 1) await tg("sendDocument", { chat_id: chat, document: g[0].id, protect_content: PROTECT });
    else await tg("sendMediaGroup", { chat_id: chat, media: g.map((f) => ({ type: "document", media: f.id })), protect_content: PROTECT });
    await sleep(500);
  }
  if (links.length) {
    await send(chat, `🔗 <b>Link download:</b>\n\n` + links.map((u, i) => `${i + 1}. ${esc(u)}`).join("\n"), { protect_content: PROTECT });
  }
  await rd("HINCRBY", "dl", String(id), 1);
  await send(chat, "✅ Selesai! Ketik /katalog buat lihat set lainnya 🎁");
}

// ---------- ADMIN ----------
const HELP =
  "🛠 <b>Perintah Admin</b>\n\n" +
  "<b>Tambah set</b>\n" +
  "<code>/tambah Nama | Isi | Link1, Link2 | Creator</code> (creator opsional; link <code>-</code> kalau mau upload file)\n" +
  "Banyak sekaligus: 1 baris = 1 set. Kirim foto + caption itu untuk 1 set + preview.\n" +
  "Set baru otomatis diposting ke channel kalau sudah ada preview.\n\n" +
  "<b>File & link</b>\n" +
  "/tambahfile NOMOR → lalu kirim foto/video/dokumen (boleh album), selesai: /selesai\n" +
  "/addlink NOMOR link… • /dellink NOMOR urutan\n\n" +
  "<b>Preview</b>\n" +
  "Foto + caption <code>/setpreview NOMOR</code> • /hapuspreview NOMOR • /cekpreview [NOMOR]\n" +
  "/previewmassal → kirim foto berurutan tanpa caption (skip / status / stop)\n\n" +
  "<b>Posting channel</b>\n" +
  "/postset 5 6 9-12 [ulang] • /postsemua (status / stop)\n" +
  "/tandaipost 1-120 (tandai sudah ada di channel) • /tandaipost hapus 5-9 • /tandaipost cek\n\n" +
  "<b>Lain-lain</b>\n" +
  "/list [halaman] • /hapus NOMOR • /setcreator 1,2,3 Nama • /stats";

async function addRecords(chat, content, photoId) {
  const records = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const pipes = (line.match(/\|/g) || []).length;
    if (records.length && pipes < 2 && /^(https?:\/\/|t\.me\/|telegram\.me\/)/i.test(line)) records[records.length - 1] += "\n" + line;
    else records.push(line);
  }
  if (!records.length) return send(chat, "⚠️ Format: <code>/tambah Nama | Isi | Link1, Link2 | Creator</code>\nBanyak set: 1 baris = 1 set.");
  const isBulk = records.length > 1;
  const added = [], failed = [], notPosted = [];
  for (let i = 0; i < records.length; i++) {
    const parts = records[i].split("|").map((x) => x.trim());
    if (parts.length < 3 || !parts[0] || !parts[1]) {
      failed.push(records[i].split("\n")[0].slice(0, 60));
      continue;
    }
    const links = parts[2] === "-" ? [] : parts[2].split(/[\s,]+/).filter(Boolean).map(normUrl).filter((u) => /^https?:\/\//i.test(u));
    const id = await rd("INCR", "pack:seq");
    const p = {
      id, nama: parts[0], isi: parts[1], links, files: [],
      creator: (parts[3] || "").replace(/\s+/g, " ").slice(0, 60),
      preview: !isBulk && photoId ? photoId : null,
      created: Date.now(),
    };
    await savePack(p);
    added.push(p);
  }
  if (!added.length) return send(chat, "⚠️ Tidak ada baris yang valid.\nFormat: <code>/tambah Nama | Isi | Link1, Link2 | Creator</code>");
  const lines = [`✅ <b>${added.length} set ditambahkan</b>\n`];
  for (const p of added) {
    lines.push(`#${p.id} <b>${esc(p.nama)}</b> — ${esc(p.isi)} • ${p.links.length} link${p.creator ? " • 👤 " + esc(p.creator) : ""}`);
    if (p.preview) {
      const r = await postPack(p);
      if (!r.ok) notPosted.push(`#${p.id} (${r.reason})`);
    } else notPosted.push(`#${p.id}`);
  }
  if (failed.length) lines.push(`\n⚠️ ${failed.length} baris dilewati: ${failed.map((f) => "<code>" + esc(f) + "</code>").join(", ")}`);
  if (notPosted.length)
    lines.push(`\n📭 Belum diposting ke channel (belum ada preview): ${notPosted.join(", ")}\nPasang foto: <code>/setpreview NOMOR</code> (foto + caption), lalu <code>/postset NOMOR</code>.`);
  lines.push(`\n<i>Upload file langsung: /tambahfile ${added[0].id}</i>`);
  return sendLong(chat, lines);
}

async function adminCommand(cmd, arg, m) {
  const uid = m.from.id;
  const chat = m.chat.id;
  const media = mediaOf(m);

  switch (cmd) {
    case "/help":
    case "/admin":
      return send(chat, HELP);

    case "/tambah":
      return addRecords(chat, arg, media && media.t === "photo" ? media.id : null);

    case "/tambahfile": {
      const id = parseInt(arg, 10);
      const p = id ? await getPack(id) : null;
      if (!p) return send(chat, "Format: <code>/tambahfile NOMOR</code>, lalu kirim file (boleh album, bisa caption <code>/tambahfile NOMOR</code> di file pertama). Selesai: /selesai");
      await rd("SET", `tf:${uid}`, String(id), "EX", 900);
      if (media) {
        p.files = [...(p.files || []), media];
        await savePack(p);
        return send(chat, `📎 File masuk ke #${id} (total ${p.files.length}). Kirim file lain atau /selesai.`);
      }
      return send(chat, `📎 Siap! Kirim file untuk <b>#${id} ${esc(p.nama)}</b> (boleh album). Selesai: /selesai`);
    }
    case "/selesai": {
      const id = await rd("GET", `tf:${uid}`);
      await rd("DEL", `tf:${uid}`);
      const p = id ? await getPack(id) : null;
      return send(chat, p ? `✅ Selesai. #${p.id} sekarang berisi ${(p.files || []).length} file, ${(p.links || []).length} link.` : "Tidak ada sesi upload aktif.");
    }

    case "/addlink": {
      const mm = /^(\d+)\s+([\s\S]+)$/.exec(arg);
      const urls = mm ? (mm[2].match(URL_RE) || []).concat((mm[2].match(/(?:^|\s)((?:t\.me|telegram\.me)\/\S+)/g) || []).map((s) => normUrl(s.trim()))) : [];
      const p = mm ? await getPack(mm[1]) : null;
      if (!p || !urls.length) return send(chat, "Format: <code>/addlink NOMOR https://link</code>");
      p.links = [...(p.links || []), ...[...new Set(urls)]];
      await savePack(p);
      return send(chat, `🔗 Link ditambahkan ke #${p.id} (total ${p.links.length} link).`);
    }
    case "/dellink": {
      const mm = /^(\d+)\s+(\d+)$/.exec(arg);
      const p = mm ? await getPack(mm[1]) : null;
      if (!p) return send(chat, "Format: <code>/dellink NOMOR urutan</code>");
      const i = +mm[2] - 1;
      if (!(p.links || [])[i]) return send(chat, "Urutan link tidak ada.");
      p.links.splice(i, 1);
      await savePack(p);
      return send(chat, `🗑 Link dihapus. Sisa ${p.links.length} link di #${p.id}.`);
    }

    case "/setpreview": {
      const id = parseInt(arg, 10);
      const p = id ? await getPack(id) : null;
      if (!media || media.t !== "photo" || !p) return send(chat, "Kirim <b>foto</b> dengan caption <code>/setpreview NOMOR</code>.");
      const had = !!p.preview;
      p.preview = media.id;
      await savePack(p);
      return send(chat, `🖼 Preview #${id} ${had ? "diganti" : "dipasang"}. Posting: <code>/postset ${id}</code>`);
    }
    case "/hapuspreview": {
      const p = await getPack(parseInt(arg, 10));
      if (!p) return send(chat, "Format: <code>/hapuspreview NOMOR</code>");
      p.preview = null;
      await savePack(p);
      return send(chat, `🗑 Preview #${p.id} dihapus.`);
    }
    case "/cekpreview": {
      if (arg) {
        const p = await getPack(parseInt(arg, 10));
        if (!p) return send(chat, "Set tidak ditemukan.");
        if (p.preview) return tg("sendPhoto", { chat_id: chat, photo: p.preview, caption: `#${p.id} ${p.nama}` });
        return send(chat, `#${p.id} ${esc(p.nama)} → ❌ belum ada preview`);
      }
      const no = (await getPacks()).filter((p) => !p.preview).map((p) => p.id);
      return send(chat, no.length ? `❌ Belum ada preview (${no.length}): ${no.join(", ")}` : "✅ Semua set sudah punya preview.");
    }

    case "/previewmassal": {
      if (/^stop$/i.test(arg)) {
        const left = await rd("LLEN", "pm");
        await rd("DEL", "pm");
        await rd("DEL", "pm:on");
        return send(chat, `⏹ Preview massal dihentikan. Sisa set tanpa preview: ${left}.`);
      }
      if (/^status$/i.test(arg)) {
        const q = (await rd("LRANGE", "pm", 0, 4)) || [];
        const left = await rd("LLEN", "pm");
        return send(chat, left ? `🖼 Sisa ${left} set. Foto berikutnya masuk ke: #${q[0]}` : "Tidak ada sesi preview massal.");
      }
      if (/^skip$/i.test(arg)) {
        const id = await rd("LPOP", "pm");
        return send(chat, id ? `⏭ #${id} dilewati.` : "Antrean kosong.");
      }
      const ids = (await getPacks()).filter((p) => !p.preview).map((p) => String(p.id));
      if (!ids.length) return send(chat, "✅ Semua set sudah punya preview.");
      await rd("DEL", "pm");
      await rd("RPUSH", "pm", ...ids);
      await rd("SET", "pm:on", "1", "EX", 7200);
      const first = await getPack(ids[0]);
      return send(
        chat,
        `🖼 <b>Preview massal</b>: ${ids.length} set belum punya preview.\nKirim foto <b>satu per satu, tanpa caption</b>, urut sesuai set. Tiap foto akan dibalas dengan set tujuannya.\n` +
          `Foto pertama → <b>#${ids[0]} ${esc(first.nama)}</b>\nPerintah: /previewmassal skip • status • stop`
      );
    }

    case "/postset": {
      const force = /(^|\s)ulang(\s|$)/i.test(arg);
      const nos = parseNos(arg.replace(/ulang/gi, " "));
      if (!nos.length) return send(chat, "Format: <code>/postset 5 6 9-12</code> (tambah <code>ulang</code> untuk posting ulang)");
      const r = await enqueue(nos, force);
      await send(
        chat,
        `📮 Antre ${r.added} set.` +
          (r.sudah ? ` Sudah pernah diposting ${r.sudah} (dilewati, pakai <code>ulang</code> kalau mau posting lagi).` : "") +
          (r.tidakAda ? ` Nomor tidak ada: ${r.tidakAda}.` : "")
      );
      return runBatch();
    }
    case "/postsemua": {
      if (/^stop$/i.test(arg)) {
        const left = await rd("LLEN", "pq");
        await rd("DEL", "pq");
        return send(chat, `⏹ Antrean dihentikan (${left} set dibatalkan).`);
      }
      if (/^status$/i.test(arg)) return send(chat, `📮 Sisa antrean posting: ${await rd("LLEN", "pq")} set.`);
      const ids = (await getPacks()).map((p) => p.id);
      const r = await enqueue(ids, false);
      await send(chat, `🚀 Posting massal: ${r.added} set diantre, ${r.sudah} sudah ada di channel (dilewati). Lanjut otomatis bertahap.`);
      return runBatch();
    }
    case "/tandaipost": {
      if (/^cek$/i.test(arg)) {
        const posted = await hashMap("posted");
        const packs = await getPacks();
        const belum = packs.filter((p) => !posted[p.id]).map((p) => p.id);
        return send(chat, `📊 Total set: <b>${packs.length}</b>\n✅ Sudah di channel: <b>${packs.length - belum.length}</b>\n⏳ Belum: <b>${belum.length}</b>` + (belum.length && belum.length <= 40 ? `\nNomor: ${belum.join(", ")}` : ""));
      }
      const hapus = /^hapus(\s|$)/i.test(arg);
      const nos = parseNos(hapus ? arg.replace(/^hapus/i, "") : arg);
      const have = new Set((await getPacks()).map((p) => p.id));
      const valid = nos.filter((n) => have.has(n));
      if (!valid.length) return send(chat, "Format: <code>/tandaipost 1-120</code> • <code>/tandaipost hapus 5-9</code> • <code>/tandaipost cek</code>");
      for (const n of valid) await (hapus ? rd("HDEL", "posted", String(n)) : rd("HSET", "posted", String(n), "1"));
      return send(chat, hapus ? `↩️ Tanda dihapus untuk ${valid.length} set.` : `✅ ${valid.length} set ditandai sudah ada di channel (akan dilewati /postsemua & /postset).`);
    }

    case "/setcreator": {
      const mm = /^([\d,\s-]+?)(?:\s+([^\d,-][\s\S]*))?$/.exec(arg);
      const nos = mm ? parseNos(mm[1]) : [];
      if (!nos.length) return send(chat, "Format: <code>/setcreator 1,2,3 Nama Creator</code> (tanpa nama = hapus creator)");
      const name = ((mm[2] || "").replace(/\s+/g, " ").trim()).slice(0, 60);
      let n = 0;
      for (const no of nos) {
        const p = await getPack(no);
        if (!p) continue;
        p.creator = name;
        await savePack(p);
        n++;
      }
      return send(chat, `👤 Creator ${name ? "diatur ke <b>" + esc(name) + "</b>" : "dihapus"} untuk ${n} set.`);
    }
    case "/hapus": {
      const nos = parseNos(arg);
      if (!nos.length) return send(chat, "Format: <code>/hapus NOMOR</code> (boleh banyak: <code>/hapus 3 5 8-10</code>)");
      for (const n of nos) {
        await rd("HDEL", "packs", String(n));
        await rd("HDEL", "posted", String(n));
      }
      return send(chat, `🗑 ${nos.length} set dihapus.`);
    }
    case "/list": {
      const packs = await getPacks();
      if (!packs.length) return send(chat, "Belum ada set.");
      const [posted, dl] = [await hashMap("posted"), await hashMap("dl")];
      const per = 40;
      const page = Math.max(1, parseInt(arg, 10) || 1);
      const slice = packs.slice((page - 1) * per, page * per);
      const lines = [`📚 Set ${packs.length} • halaman ${page}/${Math.ceil(packs.length / per)}\n`];
      for (const p of slice)
        lines.push(`#${p.id} ${esc(p.nama)}${p.creator ? " — " + esc(p.creator) : ""} • ${posted[p.id] ? "📢" : "⏳"}${p.preview ? "🖼" : "❌"} • ${(p.files || []).length}f/${(p.links || []).length}l • ${dl[p.id] || 0}x`);
      lines.push("\n📢 sudah di channel • 🖼 ada preview • f=file l=link • x=diambil");
      return sendLong(chat, lines);
    }
    case "/stats": {
      const [np, nu, dl, q] = [await rd("HLEN", "packs"), await rd("SCARD", "users"), await hashMap("dl"), await rd("LLEN", "pq")];
      const sum = Object.values(dl).reduce((a, b) => a + Number(b), 0);
      return send(chat, `📊 Set: <b>${np}</b>\n👥 User: <b>${nu}</b>\n📥 Total pengambilan: <b>${sum}</b>\n📮 Antrean posting: <b>${q}</b>`);
    }
  }
  return false;
}

// ---------- MENU USER ----------
const MENU = (uid) => ({
  keyboard: [[{ text: "📚 Katalog" }, { text: "🎲 Acak" }], [{ text: "🔍 Cari" }, { text: "ℹ️ Bantuan" }], ...(isAdmin(uid) ? [[{ text: "🛠 Admin" }]] : [])],
  resize_keyboard: true,
});
const BANTUAN =
  "ℹ️ <b>Cara ambil set gratis</b>\n\n1. Buka 📚 Katalog atau tombol di channel\n2. Pilih set yang kamu mau\n" +
  (FORCE_JOIN ? "3. Join channel dulu kalau diminta, lalu tekan <b>Sudah join</b>\n" : "") +
  `${FORCE_JOIN ? "4" : "3"}. Bot kirim file/link-nya langsung\n\n` +
  (DAILY_LIMIT > 0 ? `Batas ambil: ${DAILY_LIMIT} set per hari.\n` : "") +
  "🎲 Acak = ambil set random • 🔍 Cari = cari berdasarkan nama/creator";

const KAT_PER = 8;
async function buildKatalog(page) {
  const packs = (await getPacks()).filter((p) => total(p) > 0).reverse();
  if (!packs.length) return null;
  const pages = Math.ceil(packs.length / KAT_PER);
  const pg = Math.min(Math.max(1, page), pages);
  const rows = packs.slice((pg - 1) * KAT_PER, pg * KAT_PER).map((p) => [{ text: `${p.nama}${p.creator ? " • " + p.creator : ""}`.slice(0, 60), callback_data: `get:${p.id}` }]);
  const nav = [];
  if (pg > 1) nav.push({ text: "⬅️ Sebelumnya", callback_data: `kat:${pg - 1}` });
  if (pg < pages) nav.push({ text: "Berikutnya ➡️", callback_data: `kat:${pg + 1}` });
  if (nav.length) rows.push(nav);
  return { text: `📚 <b>Katalog</b> (${packs.length} set) • halaman ${pg}/${pages}\nTap untuk ambil:`, reply_markup: { inline_keyboard: rows } };
}

// ---------- HANDLER ----------
async function onMessage(m) {
  if (!m.chat || m.chat.type !== "private" || !m.from) return;
  const uid = m.from.id;
  const chat = m.chat.id;
  const text = (m.text || m.caption || "").trim();
  const c0 = text.split(/\s/)[0];
  const cmd = c0.startsWith("/") ? c0.split("@")[0].toLowerCase() : "";
  const arg = text.slice(c0.length).trim();

  const menuText = cmd ? "" : text;
  if (cmd === "/start") {
    await rd("SADD", "users", String(uid));
    const mm = /^p(\d+)$/.exec(arg);
    if (mm) return deliver(uid, chat, mm[1]);
    return send(chat, "Halo! 🎁 Di sini kamu bisa ambil set gratis.\nPilih menu di bawah ya 👇", { reply_markup: MENU(uid) });
  }
  if (cmd === "/katalog" || menuText === "📚 Katalog") {
    const k = await buildKatalog(1);
    return k ? send(chat, k.text, { reply_markup: k.reply_markup }) : send(chat, "Belum ada set. Tunggu update berikutnya ya!");
  }
  if (cmd === "/acak" || menuText === "🎲 Acak") {
    const packs = (await getPacks()).filter((p) => total(p) > 0);
    if (!packs.length) return send(chat, "Belum ada set. Tunggu update berikutnya ya!");
    return deliver(uid, chat, packs[Math.floor(Math.random() * packs.length)].id);
  }
  if (cmd === "/cari" || menuText === "🔍 Cari") {
    await rd("SET", `sr:${uid}`, "1", "EX", 300);
    return send(chat, "🔍 Ketik nama set atau creator yang dicari:");
  }
  if (cmd === "/bantuan" || menuText === "ℹ️ Bantuan") return send(chat, BANTUAN);
  if (menuText === "🛠 Admin" && isAdmin(uid)) return send(chat, HELP);
  if (!cmd && text && !mediaOf(m) && (await rd("GET", `sr:${uid}`))) {
    await rd("DEL", `sr:${uid}`);
    const q = text.toLowerCase();
    const hits = (await getPacks()).filter((p) => total(p) > 0 && `${p.nama} ${p.creator || ""}`.toLowerCase().includes(q)).reverse().slice(0, 10);
    if (!hits.length) return send(chat, `😕 Tidak ada set yang cocok dengan "<b>${esc(text.slice(0, 40))}</b>". Coba kata lain lewat 🔍 Cari.`);
    return send(chat, `🔍 Hasil untuk "<b>${esc(text.slice(0, 40))}</b>":`, {
      reply_markup: { inline_keyboard: hits.map((p) => [{ text: `${p.nama}${p.creator ? " • " + p.creator : ""}`.slice(0, 60), callback_data: `get:${p.id}` }]) },
    });
  }

  if (!isAdmin(uid)) return;
  if (cmd) {
    const handled = await adminCommand(cmd, arg, m);
    if (handled !== false) return;
  }
  const f = mediaOf(m);
  if (f && !cmd) {
    // 1) sesi /tambahfile aktif -> masuk sebagai file set
    const tf = await rd("GET", `tf:${uid}`);
    if (tf) {
      const p = await getPack(tf);
      if (p) {
        p.files = [...(p.files || []), f];
        await savePack(p);
      }
      return;
    }
    // 2) preview massal aktif -> foto masuk ke set berikutnya (LPOP atomik, aman untuk album)
    if (f.t === "photo" && (await rd("GET", "pm:on"))) {
      const id = await rd("LPOP", "pm");
      if (!id) {
        await rd("DEL", "pm:on");
        return send(chat, "✅ Semua set sudah kebagian preview. Sesi selesai.");
      }
      const p = await getPack(id);
      if (p) {
        p.preview = f.id;
        await savePack(p);
      }
      const nextId = (await rd("LRANGE", "pm", 0, 0))[0];
      const next = nextId ? await getPack(nextId) : null;
      return send(chat, `🖼 → <b>#${id} ${p ? esc(p.nama) : "?"}</b>\n` + (next ? `Berikutnya: #${nextId} ${esc(next.nama)}` : "🎉 Itu yang terakhir."));
    }
  }
}

async function onCallback(cb) {
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
  const mm = /^get:(\d+)$/.exec(cb.data || "");
  if (mm && cb.message) return deliver(cb.from.id, cb.message.chat.id, mm[1]);
  const kp = /^kat:(\d+)$/.exec(cb.data || "");
  if (kp && cb.message) {
    const k = await buildKatalog(+kp[1]);
    if (k) await tg("editMessageText", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: k.text, parse_mode: "HTML", reply_markup: k.reply_markup });
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) return res.status(401).end();
  try {
    const u = req.body || {};
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
    await runBatch(); // lanjutkan antrean posting bertahap (no-op kalau kosong)
  } catch (e) {
    console.error("webhook error:", e);
  }
  res.status(200).send("ok");
};
