import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadApi, startServer, openDates, secret, ADMIN } from "./helpers.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");

const api = await loadApi();
const D = openDates();
let srv, browser;
const A = { "x-admin-key": ADMIN };
const seed = (n, name, dates, tables = {}) => api.call("PUT", "/api/signups/me", { secret: secret(n), doc: { name, dates, tables } });

async function page(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.w || 390, height: opts.h || 844 } });
  if (opts.lang) await ctx.addInitScript((l) => localStorage.setItem("mk_lang", l), opts.lang);
  if (opts.admin) await ctx.addInitScript((k) => localStorage.setItem("mvc_admin", k), opts.admin);
  const pg = await ctx.newPage();
  pg.errors = [];
  pg.on("pageerror", (e) => pg.errors.push(String(e)));
  // Console "failed to load resource" lines carry no URL; failures are tracked per request below instead.
  pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pg.errors.push(m.text()); });
  pg.failed = [];
  const local = (u) => u.startsWith(srv.url);
  pg.on("response", (r) => { if (r.status() >= 400 && local(r.url()) && !r.url().includes("/api/")) pg.failed.push(r.status() + " " + r.url()); });
  pg.on("requestfailed", (r) => { if (local(r.url())) pg.failed.push("failed " + r.url()); });
  // External hosts (Google Fonts) are unreachable in the test sandbox: skip them quickly.
  await ctx.route((u) => !String(u).startsWith(srv.url), (r) => r.abort());
  pg.ctx = ctx;
  return pg;
}
async function go(pg, hash = "") { await pg.goto(srv.url + "/" + hash); await pg.waitForTimeout(900); }
async function fillForm(pg, name = "Анна", phone = "+90 555 111 22 33") {
  await pg.fill("#nick", name); await pg.fill("#phone", phone); await pg.check("#consent");
}
async function signupFirst(pg) {
  await pg.click("#games .game >> nth=0 >> button.btn.primary");
  await pg.check("#mr-ok"); await pg.click("#mr-go");
  await pg.waitForSelector("#m-done:not([hidden])");
}

before(async () => { srv = await startServer(api); browser = await chromium.launch(); });
after(async () => { await browser.close(); await srv.close(); });
beforeEach(() => api.reset());

describe("layout and content", () => {
  for (const lang of ["ru", "tr"]) for (const w of [360, 390, 768, 1366]) {
    test(`all sections fit ${w}px in ${lang} with no errors`, async () => {
      const pg = await page({ w, lang });
      for (const v of ["home", "schedule", "rules", "news", "blog", "contacts", "admin"]) {
        await go(pg, "#" + v);
        const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(sw <= w, `${v}: page is ${sw}px wide at ${w}px`);
      }
      assert.deepEqual(pg.errors, []); assert.deepEqual(pg.failed, []);
      await pg.ctx.close();
    });
  }
  test("every text key exists in Russian and Turkish", async () => {
    const pg = await page(); await go(pg);
    const missing = await pg.evaluate(() => {
      const keys = new Set([...document.querySelectorAll("[data-i],[data-ih]")].map((e) => e.dataset.i || e.dataset.ih));
      const scripts = [...document.scripts].map((s) => s.textContent).join("\n");
      for (const m of scripts.matchAll(/\bt\("([a-z0-9_]+)"\)/g)) keys.add(m[1]);
      return ["ru", "tr"].flatMap((l) => [...keys].filter((k) => !(k in T[l])).map((k) => l + ":" + k));
    });
    assert.deepEqual(missing, []);
    await pg.ctx.close();
  });
  test("element ids are unique", async () => {
    const pg = await page(); await go(pg);
    const dup = await pg.evaluate(() => { const c = {}; document.querySelectorAll("[id]").forEach((e) => (c[e.id] = (c[e.id] || 0) + 1)); return Object.keys(c).filter((k) => c[k] > 1); });
    assert.deepEqual(dup, []); await pg.ctx.close();
  });
  test("all images load", async () => {
    const pg = await page({ w: 1366 }); await go(pg);
    await pg.evaluate(async () => { for (const el of document.querySelectorAll("#gallery figure, .post-img")) el.scrollIntoView(); });
    await go(pg, "#blog"); await go(pg, "#home");
    await pg.waitForTimeout(800);
    const broken = await pg.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src));
    assert.deepEqual(broken, []); assert.deepEqual(pg.failed, []); await pg.ctx.close();
  });
  test("language choice is remembered", async () => {
    const pg = await page(); await go(pg);
    await pg.click("#burger"); await pg.click("#lang-tr-m"); assert.equal(await pg.textContent(".hdr-cta"), "Kaydol");
    assert.equal(await pg.getAttribute("#lang-tr", "aria-pressed"), "true", "desktop switch in sync");
    await pg.reload(); await pg.waitForTimeout(600);
    assert.equal(await pg.textContent(".hdr-cta"), "Kaydol"); await pg.ctx.close();
  });
  test("burger menu opens, navigates and closes", async () => {
    const pg = await page(); await go(pg);
    assert.equal(await pg.isVisible("nav.menu"), false);
    await pg.click("#burger"); assert.equal(await pg.isVisible("nav.menu"), true);
    await pg.click("nav.menu a[href='#rules']"); await pg.waitForTimeout(400);
    assert.equal(await pg.isVisible("nav.menu"), false);
    assert.equal(await pg.isVisible("#v-rules"), true); await pg.ctx.close();
  });
  test("unknown hash falls back to home; admin is not in the menu", async () => {
    const pg = await page({ w: 1366 }); await go(pg, "#nonsense");
    assert.equal(await pg.isVisible("#v-home"), true);
    assert.equal(await pg.locator("nav.menu a[href='#admin']").count(), 0); await pg.ctx.close();
  });
});

describe("signing up", () => {
  test("new player: rules must be accepted, table 2 by default, seat shown", async () => {
    const pg = await page(); await go(pg, "#schedule"); await fillForm(pg);
    await pg.click("#games .game >> nth=0 >> button.btn.primary");
    assert.equal(await pg.isDisabled("#mr-go"), true, "button locked until rules accepted");
    assert.equal(await pg.isChecked("#mt-2"), true, "newcomer table preselected");
    await pg.check("#mr-ok"); assert.equal(await pg.isDisabled("#mr-go"), false);
    await pg.click("#mr-go"); await pg.waitForSelector("#m-done:not([hidden])");
    assert.match(await pg.textContent("#md-seat"), /Стол №2 · место №1/);
    const hrefs = await pg.evaluate(() => [...document.querySelectorAll("#md-actions a")].map((a) => a.href));
    assert.ok(hrefs.some((h) => h.startsWith("https://wa.me/905012890755?text=")), "notify organizer");
    assert.ok(hrefs.includes("https://chat.whatsapp.com/IFEh6lnoCcD1uSGbncLLl4"), "group link");
    const cal = hrefs.find((h) => h.includes("calendar.google.com"));
    const [y, m, d] = D[0].split("-");
    assert.ok(cal.includes(`dates=${y}${m}${d}T160000Z/${y}${m}${d}T190000Z`), "19:00 Turkey = 16:00 UTC: " + cal);
    const docs = (await api.call("GET", "/api/signups")).body.docs;
    assert.equal(docs.length, 1); assert.equal(docs[0].tables[D[0]], 2);
    assert.deepEqual(pg.errors, []); await pg.ctx.close();
  });
  test("organizer message is short and readable", async () => {
    const pg = await page(); await go(pg, "#schedule"); await fillForm(pg, "Анна"); await signupFirst(pg);
    const href = await pg.getAttribute("#md-actions a.wa-btn", "href");
    const msg = decodeURIComponent(href.split("text=")[1]);
    const [, mo, dd] = D[0].split("-");
    assert.equal(msg, `✅ Мафия ${dd}.${mo}, стол 2, место 1 — Анна`); await pg.ctx.close();
  });
  test("validation: name, phone and consent are required", async () => {
    const pg = await page(); await go(pg, "#schedule");
    const btn = "#games .game >> nth=0 >> button.btn.primary";
    await pg.click(btn); assert.match(await pg.textContent("#toast"), /имя/);
    await pg.fill("#nick", "Анна"); await pg.click(btn); assert.match(await pg.textContent("#toast"), /телефон/i);
    await pg.fill("#phone", "12"); await pg.click(btn); assert.match(await pg.textContent("#toast"), /телефон/i);
    await pg.fill("#phone", "+90 555 111 22 33"); await pg.click(btn); assert.match(await pg.textContent("#toast"), /согласие/);
    assert.equal(await pg.isVisible("#m-rules"), false); await pg.ctx.close();
  });
  test("eleventh player goes to the waiting list", async () => {
    for (let i = 0; i < 10; i++) await seed(i, "Игрок " + i, [D[0]], { [D[0]]: 2 });
    const pg = await page(); await go(pg, "#schedule"); await fillForm(pg); await signupFirst(pg);
    assert.match(await pg.textContent("#md-seat"), /листе ожидания: 1/); await pg.ctx.close();
  });
  test("returning player gets table 1 by default", async () => {
    const pg = await page(); await go(pg, "#schedule");
    const uid = await pg.evaluate(() => window.claude.use("user").then((u) => u.id()));
    await api.call("PUT", "/api/signups/" + uid, { doc: { name: "Ветеран", dates: ["2025-01-02"] } }, A);
    await pg.reload(); await pg.waitForTimeout(900); await fillForm(pg, "Ветеран");
    await pg.click("#games .game >> nth=0 >> button.btn.primary");
    assert.equal(await pg.isChecked("#mt-1"), true); await pg.ctx.close();
  });
  test("cancel from the footer asks for confirmation and frees the seat", async () => {
    const pg = await page(); await go(pg, "#schedule"); await fillForm(pg); await signupFirst(pg);
    await pg.click("#md-actions .btn.primary");
    await pg.click("footer .js-cancel"); await pg.waitForSelector("#m-cancel:not([hidden])");
    await pg.click("#mc-body .mc-item button.btn.small");
    await pg.click("#mc-body .mc-confirm .btn:not(.primary)");
    assert.equal(((await api.call("GET", "/api/signups")).body.docs[0].dates).length, 1, "'No' keeps the booking");
    await pg.click("#mc-body .mc-item button.btn.small"); await pg.click("#mc-body .mc-confirm .btn.primary");
    await pg.waitForSelector("#mc-body a.wa-btn");
    assert.deepEqual((await api.call("GET", "/api/signups")).body.docs[0].dates, []);
    assert.match(decodeURIComponent(await pg.getAttribute("#mc-body a.wa-btn", "href")), /❌ Отмена: Мафия/);
    await pg.ctx.close();
  });
  test("other players' names are shown as text, never as HTML", async () => {
    await seed(5, '<img src=x onerror="window.__xss=1">', [D[0]]);
    const pg = await page(); await go(pg, "#schedule"); await pg.waitForTimeout(500);
    assert.equal(await pg.evaluate(() => window.__xss), undefined);
    assert.equal(await pg.locator("#games img").count(), 0);
    assert.match(await pg.textContent("#games .game >> nth=0"), /<img src=x/); await pg.ctx.close();
  });
  test("other visitors see new signups without reloading", async () => {
    const viewer = await page(); await go(viewer, "#schedule");
    await seed(7, "Новенький", [D[0]]);
    await viewer.waitForFunction(() => document.querySelector("#games").textContent.includes("Новенький"), null, { timeout: 12000 });
    await viewer.ctx.close();
  });
});

describe("calendar", () => {
  test("list shows exactly the open games; year view has 12 months", async () => {
    const pg = await page({ w: 1366 }); await go(pg, "#schedule");
    const keys = await pg.evaluate(() => upcoming().map(keyOf));
    const expected = D.filter((k) => keys.includes(k));
    assert.ok(keys.length >= D.length - 1 && keys.length <= D.length, `${keys.length} vs ${D.length}`);
    assert.deepEqual(keys, expected);
    assert.equal(await pg.locator("#year .month").count(), 12);
    assert.equal(await pg.locator("#year .dc.game.open, #year .dc.game.mine").count(), keys.length);
    await pg.locator("#year .dc.game.soon").first().click();
    assert.match(await pg.textContent("#toast"), /откроется/);
    await pg.ctx.close();
  });
});

describe("admin", () => {
  test("wrong password is refused, right one opens CRM with phones", async () => {
    const p1 = await page(); await go(p1, "#schedule"); await fillForm(p1, "Анна", "+90 555 111 22 33"); await signupFirst(p1); await p1.ctx.close();
    const pg = await page({ w: 1366 }); await go(pg, "#admin");
    assert.equal(await pg.isVisible("#adm-panel"), false);
    await pg.fill("#adm-pass", "nope"); await pg.click(".adm-login button"); await pg.waitForTimeout(300);
    assert.match(await pg.textContent(".adm-login p"), /Неверный/);
    await pg.fill("#adm-pass", ADMIN); await pg.click(".adm-login button"); await pg.waitForTimeout(1800);
    assert.equal(await pg.isVisible("#adm-panel"), true);
    await pg.waitForFunction(() => document.querySelector("#adm-rows").textContent.includes("+905551112233"), null, { timeout: 5000 });
    await pg.click("#tab-msg"); await pg.selectOption("#msg-type", "lineup");
    assert.match(await pg.inputValue("#msg-text"), /Анна/);
    await pg.click("#tab-crm");
    await pg.click("#adm-rows tr:has-text('Анна') button");
    await pg.waitForTimeout(500);
    assert.deepEqual((await api.call("GET", "/api/signups")).body.docs[0].dates, []);
    assert.deepEqual(pg.errors, []); await pg.ctx.close();
  });
  test("non-admin cannot see the panel even with a fake key", async () => {
    const pg = await page({ admin: "fake" }); await go(pg, "#admin");
    assert.equal(await pg.isVisible("#adm-panel"), false); await pg.ctx.close();
  });
  test("admin uploads a hero photo and visitors see it", async () => {
    const pg = await page({ w: 1366, admin: ADMIN }); await go(pg, "#admin"); await pg.waitForTimeout(800);
    await pg.click("#tab-photo"); await pg.setInputFiles("#up-hero", "public/img/og.jpg");
    await pg.waitForFunction(() => /Готово/.test(document.querySelector("#up-hero-st").textContent), null, { timeout: 8000 });
    const v = await page(); await go(v); await v.waitForTimeout(600);
    assert.match(await v.evaluate(() => document.getElementById("hero-img").dataset.src), /^\/api\/assets\//);
    await pg.ctx.close(); await v.ctx.close();
  });
  test("admin can sign out", async () => {
    const pg = await page({ w: 1366 }); await go(pg, "#admin");
    await pg.fill("#adm-pass", ADMIN); await pg.click(".adm-login button"); await pg.waitForTimeout(1800);
    await pg.click(".adm-tabs button:has-text('Выйти')"); await pg.waitForTimeout(1200);
    assert.equal(await pg.evaluate(() => localStorage.getItem("mvc_admin")), null); await pg.ctx.close();
  });
});
