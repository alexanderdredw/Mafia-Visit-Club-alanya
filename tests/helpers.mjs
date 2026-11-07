import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const ADMIN = "test-admin-pass";

// Load the real function file next to a mocked @netlify/blobs.
export async function loadApi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mvc-api-"));
  fs.cpSync(path.join(HERE, "mock"), path.join(dir, "node_modules"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "netlify/functions/api.mjs"), path.join(dir, "api.mjs"));
  globalThis.Netlify = { env: { get: (k) => (k === "ADMIN_PASSWORD" ? ADMIN : undefined) } };
  const mod = await import(pathToFileURL(path.join(dir, "api.mjs")).href);
  const blobs = await import(pathToFileURL(path.join(dir, "node_modules/@netlify/blobs/index.js")).href);
  const call = async (method, p, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
    const r = await mod.default(new Request("http://t" + p, init));
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : await r.arrayBuffer(), headers: r.headers };
  };
  return { mod, call, reset: blobs.__reset };
}

// Game dates open for booking right now (Turkey time), same rule as the site.
export function openDates() {
  const out = []; const now = new Date(Date.now() + 3 * 3600e3);
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = 0; i <= 30; i++) { const d = new Date(base + i * 864e5); if ([2, 4, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10)); }
  return out;
}
export const secret = (n) => ("s" + String(n).padStart(4, "0")).padEnd(32, "x");

// Static site + /api on a local port, for browser tests.
export async function startServer(api) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png" };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname.startsWith("/api/")) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await api.mod.default(new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    const f = path.join(ROOT, "public", u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
    if (!f.startsWith(path.join(ROOT, "public")) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, r));
  return { url: `http://localhost:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
