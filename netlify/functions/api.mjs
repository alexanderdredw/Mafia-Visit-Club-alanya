import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const data = () => getStore({ name: "mafia", consistency: "strong" });
const files = () => getStore({ name: "mafia-assets", consistency: "strong" });
const pubId = (secret) => "u_" + createHash("sha256").update("mafia:" + secret).digest("hex").slice(0, 24);
const validSecret = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{24,80}$/.test(s);
const validId = (s) => typeof s === "string" && /^u_[0-9a-f]{24}$/.test(s);
const str = (v, n) => String(v ?? "").slice(0, n);

// Club schedule (must match CONFIG in the page). Turkey is UTC+3 all year.
export const RULES = { gameDays: [2, 4, 6], bookDays: 30, seats: 10, waitlist: 6, utcOffset: 3 };
function trTodayUTC(now = Date.now()) { const d = new Date(now + RULES.utcOffset * 3600e3); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
export function isBookable(key, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number); const t = Date.UTC(y, m - 1, d);
  const back = new Date(t); if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return false;
  const diff = Math.round((t - trTodayUTC(now)) / 864e5);
  return RULES.gameDays.includes(back.getUTCDay()) && diff >= 0 && diff <= RULES.bookDays;
}

function isAdmin(req) {
  const want = Netlify.env.get("ADMIN_PASSWORD") || "";
  const got = req.headers.get("x-admin-key") || "";
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Sanitize a signup; queue time (ts) is decided by the server, never the client.
function cleanSignup(d, uid, prev) {
  const dates = Array.isArray(d.dates) ? [...new Set(d.dates.filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)))].sort().slice(-80) : [];
  const ts = {}, tables = {};
  for (const k of dates) {
    ts[k] = prev?.ts?.[k] || Date.now();
    tables[k] = Number(d.tables?.[k]) === 2 ? 2 : 1;
  }
  return { uid, name: str(d.name ?? prev?.name, 40), dates, ts, tables, updatedAt: Date.now() };
}
const cleanPhone = (d) => ({ phone: str(d.phone, 20).replace(/[^\d+]/g, ""), name: str(d.name, 40), consent: !!d.consent, consentAt: Number(d.consentAt) || Date.now() });

async function listPrefix(st, prefix) {
  const { blobs } = await st.list({ prefix });
  const out = await Promise.all(blobs.map(async (b) => {
    const v = await st.get(b.key, { type: "json" });
    return v ? { ...v, id: b.key.slice(prefix.length) } : null;
  }));
  return out.filter(Boolean);
}

export default async (req) => {
  const url = new URL(req.url);
  const [col, id] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;
  const st = data();
  try {
    if (col === "me" && m === "GET") return json({ admin: isAdmin(req) });

    if (col === "signups") {
      if (m === "GET" && !id) return json({ docs: await listPrefix(st, "signups/") });
      if (m === "PUT" && id === "me") {
        const b = await req.json();
        if (!validSecret(b.secret)) return json({ error: "bad_secret" }, 400);
        const uid = pubId(b.secret);
        const prev = await st.get("signups/" + uid, { type: "json" });
        const doc = cleanSignup(b.doc || {}, uid, prev);
        const added = doc.dates.filter((k) => !(prev?.dates || []).includes(k));
        if (added.some((k) => !isBookable(k))) return json({ error: "date_closed" }, 422);
        if (added.length) {
          const all = await listPrefix(st, "signups/");
          for (const k of added) {
            const n = all.filter((x) => x.uid !== uid && (x.dates || []).includes(k) && ((x.tables || {})[k] === 2 ? 2 : 1) === doc.tables[k]).length;
            if (n >= RULES.seats + RULES.waitlist) return json({ error: "full" }, 409);
          }
        }
        if (!doc.name && added.length) return json({ error: "name_required" }, 422);
        await st.setJSON("signups/" + uid, doc);
        return json({ ok: true, uid });
      }
      if (m === "PUT" && validId(id)) {
        if (!isAdmin(req)) return json({ error: "forbidden" }, 403);
        const b = await req.json();
        const prev = await st.get("signups/" + id, { type: "json" });
        await st.setJSON("signups/" + id, cleanSignup(b.doc || {}, id, prev));
        return json({ ok: true });
      }
    }

    if (col === "phones") {
      if (m === "GET" && !id) {
        if (!isAdmin(req)) return json({ error: "forbidden" }, 403);
        return json({ docs: await listPrefix(st, "phones/") });
      }
      if (m === "POST" && id === "me") {
        const b = await req.json();
        if (!validSecret(b.secret)) return json({ error: "bad_secret" }, 400);
        const key = "phones/" + pubId(b.secret);
        if (b.op === "set") { await st.setJSON(key, cleanPhone(b.doc || {})); return json({ ok: true }); }
        return json({ doc: await st.get(key, { type: "json" }) });
      }
    }

    if (col === "settings") {
      if (m === "GET") return json({ doc: await st.get("settings/site", { type: "json" }) });
      if (m === "PUT") {
        if (!isAdmin(req)) return json({ error: "forbidden" }, 403);
        const b = await req.json(); const d = b.doc || {};
        const pic = (p) => (p && typeof p.id === "string" && typeof p.url === "string" ? { id: str(p.id, 64), url: str(p.url, 200) } : null);
        const doc = { hero: pic(d.hero), gallery: (Array.isArray(d.gallery) ? d.gallery : []).map(pic).filter(Boolean).slice(0, 12), updatedAt: Date.now() };
        await st.setJSON("settings/site", doc);
        return json({ ok: true });
      }
    }

    if (col === "assets") {
      const fs = files();
      if (m === "GET" && id) {
        const e = await fs.getWithMetadata(id, { type: "arrayBuffer" });
        if (e === null) return new Response("Not found", { status: 404 });
        return new Response(e.data, { headers: { "content-type": e.metadata?.type || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
      }
      if (!isAdmin(req)) return json({ error: "forbidden" }, 403);
      if (m === "POST" && !id) {
        const type = req.headers.get("content-type") || "";
        if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: "bad_type" }, 415);
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > 5_000_000) return json({ error: "too_large" }, 413);
        const key = crypto.randomUUID().replace(/-/g, "");
        await fs.set(key, buf, { metadata: { type } });
        return json({ id: key, url: "/api/assets/" + key, sizeBytes: buf.byteLength, contentType: type });
      }
      if (m === "DELETE" && id) { await fs.delete(id); return json({ ok: true }); }
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
};

export const config = {
  path: "/api/*",
  rateLimit: { windowLimit: 180, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
