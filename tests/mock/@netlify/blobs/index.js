// In-memory stand-in for @netlify/blobs used by the test suite.
const stores = globalThis.__blobStores || (globalThis.__blobStores = new Map());
export function getStore(o) {
  const name = typeof o === "string" ? o : o.name;
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    async setJSON(k, v) { m.set(k, { data: JSON.stringify(v), metadata: {} }); return { modified: true }; },
    async set(k, v, opt = {}) { m.set(k, { data: v, metadata: opt.metadata || {} }); return { modified: true }; },
    async get(k, opt = {}) { const e = m.get(k); if (!e) return null; return opt.type === "json" ? JSON.parse(e.data) : e.data; },
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.data, metadata: e.metadata } : null; },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: "x" })) }; },
    async delete(k) { m.delete(k); },
  };
}
export function __reset() { stores.clear(); }
