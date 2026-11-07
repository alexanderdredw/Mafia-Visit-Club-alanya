import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadApi, openDates, secret, ADMIN } from "./helpers.mjs";

const api = await loadApi();
const { call } = api;
const A = { "x-admin-key": ADMIN };
const D = openDates();
const join = (n, dates, tables = {}, name = "Игрок " + n) => call("PUT", "/api/signups/me", { secret: secret(n), doc: { name, dates, tables } });
const list = async () => (await call("GET", "/api/signups")).body.docs;

beforeEach(() => api.reset());

describe("booking rules", () => {
  test("isBookable accepts only Tue/Thu/Sat within 30 days", () => {
    const { isBookable } = api.mod;
    for (const k of D) assert.ok(isBookable(k), k);
    const now = Date.now();
    assert.equal(isBookable("2020-01-07", now), false, "past");
    assert.equal(isBookable("2099-01-01", now), false, "far future");
    assert.equal(isBookable("2026-02-30", now), false, "invalid date");
    assert.equal(isBookable("not-a-date", now), false);
    const nonGame = []; const t = new Date(D[0] + "T00:00:00Z");
    for (let i = 0; i < 7; i++) { const d = new Date(t.getTime() + i * 864e5); if (![2, 4, 6].includes(d.getUTCDay())) nonGame.push(d.toISOString().slice(0, 10)); }
    for (const k of nonGame) assert.equal(isBookable(k, now), false, "non-game day " + k);
  });
  test("there are 12-14 open games in the 30-day window", () => { assert.ok(D.length >= 12 && D.length <= 14, String(D.length)); });
});

describe("signups", () => {
  test("player can sign up and appears in public list without phone", async () => {
    const r = await join(1, [D[0]], { [D[0]]: 2 });
    assert.equal(r.status, 200);
    const docs = await list();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].name, "Игрок 1");
    assert.equal(docs[0].tables[D[0]], 2);
    assert.equal(docs[0].phone, undefined);
    assert.match(docs[0].uid, /^u_[0-9a-f]{24}$/);
  });
  test("queue time is set by the server and kept on re-save", async () => {
    await join(1, [D[0]]); const first = (await list())[0].ts[D[0]];
    await new Promise((r) => setTimeout(r, 15));
    await join(1, [D[0], D[1]]); const again = (await list())[0];
    assert.equal(again.ts[D[0]], first, "existing place kept");
    assert.ok(again.ts[D[1]] > first);
  });
  test("client cannot jump the queue with a fake timestamp", async () => {
    await join(1, [D[0]]);
    await call("PUT", "/api/signups/me", { secret: secret(2), doc: { name: "Хитрый", dates: [D[0]], ts: { [D[0]]: 1 } } });
    const docs = await list(); const cheat = docs.find((d) => d.name === "Хитрый");
    assert.ok(cheat.ts[D[0]] > 1000);
  });
  test("closed, past and non-game dates are rejected", async () => {
    assert.equal((await join(1, ["2020-01-07"])).status, 422);
    assert.equal((await join(1, ["2099-12-31"])).status, 422);
  });
  test("name is required to sign up", async () => {
    assert.equal((await join(1, [D[0]], {}, "")).status, 422);
  });
  test("bad secret is rejected", async () => {
    assert.equal((await call("PUT", "/api/signups/me", { secret: "short", doc: { name: "x", dates: [D[0]] } })).status, 400);
  });
  test("table is full after 10 seats + 6 waitlist", async () => {
    for (let i = 0; i < 16; i++) assert.equal((await join(i, [D[0]])).status, 200, "player " + i);
    assert.equal((await join(99, [D[0]])).status, 409, "17th rejected on table 1");
    assert.equal((await join(99, [D[0]], { [D[0]]: 2 })).status, 200, "table 2 still open");
  });
  test("cancel removes the date", async () => {
    await join(1, [D[0], D[1]]); await join(1, [D[1]]);
    assert.deepEqual((await list())[0].dates, [D[1]]);
  });
  test("names are trimmed to 40 characters and stored as plain text", async () => {
    await join(1, [D[0]], {}, "<img src=x onerror=alert(1)>" + "я".repeat(60));
    const n = (await list())[0].name; assert.equal(n.length, 40); assert.ok(n.startsWith("<img"));
  });
});

describe("privacy and admin", () => {
  test("phones are hidden from the public", async () => {
    await call("POST", "/api/phones/me", { secret: secret(1), op: "set", doc: { phone: "+90 555 111 22 33", name: "A", consent: true } });
    assert.equal((await call("GET", "/api/phones")).status, 403);
    assert.equal((await call("GET", "/api/phones", undefined, { "x-admin-key": "wrong" })).status, 403);
    const adm = await call("GET", "/api/phones", undefined, A);
    assert.equal(adm.status, 200); assert.equal(adm.body.docs[0].phone, "+905551112233");
  });
  test("a player reads only their own phone", async () => {
    await call("POST", "/api/phones/me", { secret: secret(1), op: "set", doc: { phone: "+905551112233", consent: true } });
    assert.equal((await call("POST", "/api/phones/me", { secret: secret(1), op: "get" })).body.doc.phone, "+905551112233");
    assert.equal((await call("POST", "/api/phones/me", { secret: secret(2), op: "get" })).body.doc, null);
  });
  test("only admin can edit someone else's signup", async () => {
    await join(1, [D[0]]); const uid = (await list())[0].uid;
    assert.equal((await call("PUT", "/api/signups/" + uid, { doc: { dates: [] } })).status, 403);
    assert.equal((await call("PUT", "/api/signups/" + uid, { doc: { dates: [] } }, A)).status, 200);
    assert.deepEqual((await list())[0].dates, []);
    assert.equal((await list())[0].name, "Игрок 1", "admin removal keeps the name");
  });
  test("/api/me reports admin only with the right password", async () => {
    assert.equal((await call("GET", "/api/me")).body.admin, false);
    assert.equal((await call("GET", "/api/me", undefined, { "x-admin-key": ADMIN + "x" })).body.admin, false);
    assert.equal((await call("GET", "/api/me", undefined, A)).body.admin, true);
  });
  test("settings: public read, admin write, sanitized", async () => {
    assert.equal((await call("PUT", "/api/settings", { doc: { hero: { id: "a", url: "/x" } } })).status, 403);
    assert.equal((await call("PUT", "/api/settings", { doc: { hero: { id: "a", url: "/api/assets/a" }, gallery: [{ id: 1 }, { id: "b", url: "/api/assets/b" }], evil: 1 } }, A)).status, 200);
    const s = (await call("GET", "/api/settings")).body.doc;
    assert.equal(s.hero.id, "a"); assert.equal(s.gallery.length, 1); assert.equal(s.evil, undefined);
  });
  test("assets: admin uploads image, public downloads, others rejected", async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    assert.equal((await call("POST", "/api/assets", jpg, { "content-type": "image/jpeg" })).status, 403);
    assert.equal((await call("POST", "/api/assets", jpg, { ...A, "content-type": "text/html" })).status, 415);
    const up = await call("POST", "/api/assets", jpg, { ...A, "content-type": "image/jpeg" });
    assert.equal(up.status, 200);
    const got = await call("GET", up.body.url.replace(/^/, ""));
    assert.equal(got.status, 200); assert.equal(got.headers.get("content-type"), "image/jpeg");
    assert.equal((await call("DELETE", up.body.url, undefined, A)).status, 200);
    assert.equal((await call("GET", up.body.url)).status, 404);
  });
  test("unknown routes return 404", async () => {
    assert.equal((await call("GET", "/api/nope")).status, 404);
    assert.equal((await call("DELETE", "/api/signups/me")).status, 404);
  });
});
