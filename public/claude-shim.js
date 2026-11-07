/* Mafia Visit Club — storage bridge for Netlify.
   The page was written against a small db/user/assets interface; this file
   provides that interface on top of the site's own /api (Netlify Functions + Blobs). */
(function () {
  var API = "/api";
  function rnd() { var a = new Uint8Array(24); crypto.getRandomValues(a); return btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  var secret = null, adminKey = "";
  try { secret = localStorage.getItem("mvc_secret"); adminKey = localStorage.getItem("mvc_admin") || ""; } catch (e) {}
  if (!secret || !/^[A-Za-z0-9_-]{24,80}$/.test(secret)) { secret = rnd(); try { localStorage.setItem("mvc_secret", secret); } catch (e) {} }

  function headers(extra) { var h = Object.assign({}, extra || {}); if (adminKey) h["x-admin-key"] = adminKey; return h; }
  function req(path, opt) {
    opt = opt || {};
    return fetch(API + path, Object.assign({}, opt, { headers: headers(opt.headers), cache: "no-store" })).then(function (r) {
      if (!r.ok) { var e = new Error("HTTP " + r.status); e.code = r.status === 403 ? "not_granted" : "unavailable"; throw e; }
      return r.json();
    });
  }
  function jsonBody(o) { return { headers: { "content-type": "application/json" }, body: JSON.stringify(o) }; }

  var myIdP = null;
  function myId() {
    return myIdP || (myIdP = crypto.subtle.digest("SHA-256", new TextEncoder().encode("mafia:" + secret)).then(function (b) {
      return "u_" + Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, "0"); }).join("").slice(0, 24);
    }));
  }
  var adminP = null;
  function isAdmin() { if (!adminKey) return Promise.resolve(false); return adminP || (adminP = req("/me").then(function (d) { return !!d.admin; }).catch(function () { return false; })); }

  var subs = new Set();
  function refreshAll() { subs.forEach(function (s) { s.run(); }); }
  function qsnap(docs) { return { docs: docs.map(function (d) { return { id: d.id, exists: true, data: function () { return d; }, metadata: {} }; }), size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } }; }
  function poll(fetcher, cb, err, ms) {
    var stopped = false, t = null;
    var s = { run: function () {
      clearTimeout(t);
      fetcher().then(cb, function (e) { if (err) err({ code: e.code || "unavailable", message: String(e) }); })
        .then(function () { if (!stopped) t = setTimeout(s.run, ms); });
    } };
    subs.add(s); s.run();
    return function () { stopped = true; clearTimeout(t); subs.delete(s); };
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshAll(); });

  var db = { collection: function (c) { return {
    onSnapshot: function (cb, err) {
      if (c === "signups") return poll(function () { return req("/signups").then(function (d) { return qsnap(d.docs); }); }, cb, err, 8000);
      if (c === "phones") return poll(function () { return req("/phones").then(function (d) { return qsnap(d.docs); }); }, cb, err, 15000);
      return function () {};
    },
    doc: function (id) { return {
      id: id,
      get: function () {
        if (c === "phones") return myId().then(function (me) {
          if (id !== me) return { id: id, exists: false, data: function () {} };
          return req("/phones/me", Object.assign({ method: "POST" }, jsonBody({ secret: secret, op: "get" }))).then(function (d) { return { id: id, exists: !!d.doc, data: function () { return d.doc || undefined; } }; });
        });
        if (c === "settings") return req("/settings").then(function (d) { return { id: id, exists: !!d.doc, data: function () { return d.doc || undefined; } }; });
        return Promise.resolve({ id: id, exists: false, data: function () {} });
      },
      set: function (doc) {
        return myId().then(function (me) {
          if (c === "signups") return id === me ? req("/signups/me", Object.assign({ method: "PUT" }, jsonBody({ secret: secret, doc: doc })))
                                                : req("/signups/" + encodeURIComponent(id), Object.assign({ method: "PUT" }, jsonBody({ doc: doc })));
          if (c === "phones") return req("/phones/me", Object.assign({ method: "POST" }, jsonBody({ secret: secret, op: "set", doc: doc })));
          if (c === "settings") return req("/settings", Object.assign({ method: "PUT" }, jsonBody({ doc: doc })));
          throw new Error("unsupported");
        }).then(function () { refreshAll(); });
      },
      onSnapshot: function (cb, err) {
        if (c === "settings") return poll(function () { return req("/settings").then(function (d) { return { id: id, exists: !!d.doc, data: function () { return d.doc || {}; } }; }); }, cb, err, 60000);
        return function () {};
      }
    }; }
  }; } };

  var user = {
    id: myId,
    isOwner: isAdmin, canEdit: isAdmin,
    can: function () { return Promise.resolve(null); },
    me: function () { return Promise.all([myId(), isAdmin()]).then(function (r) { return { id: r[0], name: "", avatarUrl: "", color: "", email: null, isOwner: r[1], canEdit: r[1] }; }); }
  };

  function shrink(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type)) return resolve(file);
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 2000, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement("canvas"); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
        cv.toBlob(function (b) { resolve(b || file); }, "image/jpeg", 0.86);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  var assets = {
    upload: function (file) { return shrink(file).then(function (b) { return req("/assets", { method: "POST", headers: { "content-type": b.type || "image/jpeg" }, body: b }); }); },
    delete: function (id) { return req("/assets/" + encodeURIComponent(id), { method: "DELETE" }); },
    list: function () { return Promise.resolve({ assets: [], usage: {} }); }
  };

  window.claude = { use: function (name) {
    if (name === "db") return Promise.resolve(db);
    if (name === "user") return Promise.resolve(user);
    if (name === "assets") return isAdmin().then(function (a) { return a ? assets : null; });
    return Promise.resolve(null);
  } };

  /* ---- admin sign-in on #admin ---- */
  var T = {
    ru: { t: "Пароль администратора", b: "Войти", e: "Неверный пароль", o: "Выйти из админки" },
    tr: { t: "Yönetici şifresi", b: "Giriş yap", e: "Şifre yanlış", o: "Yönetici panelinden çık" }
  };
  function L() { return (document.documentElement.lang === "tr" ? T.tr : T.ru); }
  document.addEventListener("DOMContentLoaded", function () {
    var box = document.getElementById("adm-denied");
    if (box && !adminKey) {
      var f = document.createElement("form"); f.className = "adm-login";
      f.innerHTML = '<label for="adm-pass" class="label"></label><input id="adm-pass" type="password" autocomplete="current-password" required><button class="btn primary" type="submit"></button><p class="note warn" hidden></p>';
      f.querySelector("label").textContent = L().t; f.querySelector("button").textContent = L().b;
      f.addEventListener("submit", function (e) {
        e.preventDefault(); var v = f.querySelector("input").value.trim(); var msg = f.querySelector("p");
        fetch(API + "/me", { headers: { "x-admin-key": v }, cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
          if (d.admin) { try { localStorage.setItem("mvc_admin", v); } catch (_) {} location.reload(); }
          else { msg.textContent = L().e; msg.hidden = false; }
        }).catch(function () { msg.textContent = L().e; msg.hidden = false; });
      });
      box.appendChild(f);
    }
    var bar = document.querySelector(".adm-tabs");
    if (bar && adminKey) {
      var out = document.createElement("button"); out.type = "button"; out.className = "btn small"; out.textContent = L().o;
      out.addEventListener("click", function () { try { localStorage.removeItem("mvc_admin"); } catch (_) {} location.hash = "#home"; location.reload(); });
      bar.appendChild(out);
    }
  });
})();
