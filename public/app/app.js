/* CLEAR English Academy: academy app. Admin runs the academy; a student sees only their own lessons, receipts and published reports.
   Data and security live in Supabase (row-level security). This file is the interface only. */
(function () {
  "use strict";

  /* ------------------------------------------------------------ settings */
  var PRICES = {
    general:      { name: "General English",  usd: 79,  egp: 4000 },
    business:     { name: "Business English", usd: 99,  egp: 5000 },
    conversation: { name: "Conversation",     usd: 119, egp: 6000 },
    esp:          { name: "ESP",              usd: 139, egp: 7000 }
  };
  var PACKS = [{ levels: 1, off: 0 }, { levels: 2, off: 0.08 }, { levels: 3, off: 0.12 }];
  var STATUS = { lead: "Lead", test: "Test booked", active: "Active", paused: "Paused", completed: "Completed", inactive: "Inactive" };
  var LSTATUS = {
    scheduled: "Scheduled", completed: "Completed", moved: "Moved",
    late_cancel: "Late cancel (counts)", no_show: "No show (counts)", cancelled_by_academy: "Cancelled by academy"
  };
  var USED = ["completed", "late_cancel", "no_show"];
  var METHODS = ["InstaPay", "Bank transfer", "Payment link", "Cash", "Other"];
  var CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];
  var SKILLS = ["Speaking", "Listening", "Reading", "Writing"];
  var RECS = ["Vocabulary", "Grammar", "Pronunciation and fluency"];
  var ISSUER = "Mohamed Tarek, trading as CLEAR English Academy";
  var TERMS = "Payments are non-refundable, except where the law gives the student a right to cancel (written request within 14 days of paying; unused lessons refunded minus payment fees, delivered lessons charged at one eighth of the level price each). Unused lessons can be transferred to another learner referred by the student. Lessons are rescheduled through the academy with at least 24 hours' notice. The 8 lessons of a level are valid for 10 weeks. A pause of up to one month is allowed and counts within them. If the academy cannot deliver paid lessons, they are refunded or rescheduled.";
  var WHATSAPP = "https://wa.me/201120223509";

  /* ------------------------------------------------------------ helpers */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function opt(list, sel, labels) {
    return list.map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === sel ? " selected" : "") + ">" + esc(labels ? labels[v] : v) + "</option>";
    }).join("");
  }
  function money(n, cur) {
    n = Number(n) || 0;
    var s = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    return cur === "EGP" ? "EGP " + s : "$" + s;
  }
  function todayStr() { var d = new Date(); d = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 10); }
  function addDays(dstr, n) { var d = new Date(dstr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function fmtDT(iso, withTz) {
    var o = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
    if (withTz) o.timeZoneName = "short";
    return new Date(iso).toLocaleString([], o);
  }
  function fmtDay(iso) { return new Date(iso).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }); }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function dayKey(iso) { var d = new Date(iso); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function localInputValue(date) {
    var d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }
  function logo() { return $("#logoTpl").innerHTML; }
  function toast(msg, bad) {
    var t = $("#toast"); t.textContent = msg; t.className = bad ? "bad" : ""; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, bad ? 6000 : 2800);
  }
  function unwrap(res) {
    if (res && res.error) { throw new Error(res.error.message || String(res.error)); }
    return res ? res.data : null;
  }
  function ask(message, okLabel) {
    return new Promise(function (resolve) {
      var d = document.createElement("dialog");
      d.style.cssText = "border:1px solid var(--line-strong);border-radius:14px;padding:22px;max-width:420px;background:var(--surface);color:var(--ink)";
      d.innerHTML = "<p style=\"margin:0 0 16px\">" + esc(message) + "</p><div class=\"acts\"><button class=\"btn danger\" data-v=\"1\">" + esc(okLabel || "Yes") + "</button><button class=\"btn sec\" data-v=\"0\">Cancel</button></div>";
      document.body.appendChild(d);
      d.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-v]"); if (!b) return;
        d.close(); d.remove(); resolve(b.getAttribute("data-v") === "1");
      });
      d.addEventListener("cancel", function () { d.remove(); resolve(false); });
      if (d.showModal) d.showModal(); else d.setAttribute("open", "");
    });
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { toast("Copied."); }, function () { toast("Copy blocked by the browser. Select the text and copy.", true); });
    }
    toast("Copy is not available here. Select the text and copy.", true);
    return Promise.resolve();
  }
  function download(name, text, type) {
    try {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: type || "text/plain" }));
      a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    } catch (e) { toast("Download is not available here.", true); }
  }

  /* ------------------------------------------------------------ state */
  var sb = null, session = null, me = null;
  var S = { students: [], packages: [], payments: [], lessons: [], reports: [], notes: {} };
  var UI = { tab: "link", filter: "all", q: "", add: false, receipts: {}, draft: null, sent: "" };
  var root = null;

  /* ------------------------------------------------------------ business rules */
  function priceFor(program, levels, offOverride) {
    var p = PRICES[program] || PRICES.general;
    var pk = PACKS.filter(function (x) { return x.levels === levels; })[0] || PACKS[0];
    var off = offOverride != null ? offOverride : pk.off;
    return { list: p.usd * levels, off: off, usd: Math.round(p.usd * levels * (1 - off)), egp: Math.round(p.egp * levels * (1 - off)) };
  }
  function pkgPaidFraction(pkg) {
    var egp = Math.round((PRICES[pkg.program] || PRICES.general).egp * pkg.levels * (1 - Number(pkg.discount_pct) / 100));
    return S.payments.filter(function (p) { return p.package_id === pkg.id; }).reduce(function (a, p) {
      return a + (p.currency === "EGP" ? Number(p.amount) / (egp || 1) : Number(p.amount) / (Number(pkg.price_usd) || 1));
    }, 0);
  }
  function pkgRemaining(pkg, cur) {
    var f = Math.max(0, 1 - pkgPaidFraction(pkg));
    if (cur === "EGP") return Math.round((PRICES[pkg.program] || PRICES.general).egp * pkg.levels * (1 - Number(pkg.discount_pct) / 100) * f);
    return Math.round(Number(pkg.price_usd) * f * 100) / 100;
  }
  function pkgUsed(pkg) { return S.lessons.filter(function (l) { return l.package_id === pkg.id && USED.indexOf(l.status) >= 0; }).length; }
  function pkgIsPaid(pkg) { return pkgPaidFraction(pkg) >= 0.999; }
  function byId(list, id) { return list.filter(function (x) { return x.id === id; })[0]; }
  function studentName(id) { var s = byId(S.students, id); return s ? s.full_name : "Unknown"; }
  function activePackage(sid) {
    var list = S.packages.filter(function (p) { return p.student_id === sid && (p.status === "active" || p.status === "pending"); });
    return list.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; })[0] || null;
  }
  function pkgLabel(p) { return (PRICES[p.program] || PRICES.general).name + ", " + p.levels + (p.levels === 1 ? " level" : " levels") + " (" + p.lessons_total + " lessons)"; }

  /* ------------------------------------------------------------ data */
  function loadAll() {
    var t = function (name, order) {
      var q = sb.from(name).select("*"); if (order) q = q.order(order.col, { ascending: order.asc });
      return q;
    };
    return Promise.all([
      t("students", { col: "created_at", asc: false }), t("packages", { col: "created_at", asc: false }), t("payments", { col: "created_at", asc: false }),
      t("lessons", { col: "starts_at", asc: true }), t("reports", { col: "created_at", asc: false }), t("student_notes")
    ]).then(function (r) {
      S.students = unwrap(r[0]) || []; S.packages = unwrap(r[1]) || []; S.payments = unwrap(r[2]) || [];
      S.lessons = unwrap(r[3]) || []; S.reports = unwrap(r[4]) || [];
      S.notes = {}; (unwrap(r[5]) || []).forEach(function (n) { S.notes[n.student_id] = n.body; });
    });
  }
  function refresh() { return loadAll().then(render); }
  function act(promise, okMsg) {
    return Promise.resolve(promise).then(function (res) {
      var data = unwrap(res); if (okMsg) toast(okMsg); return data;
    }).catch(function (e) { toast(e.message || "Something went wrong.", true); throw e; });
  }

  /* ------------------------------------------------------------ boot and auth */
  function boot() {
    root = $("#root");
    var cfg = window.CLEAR_CONFIG;
    sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true } });
    sb.auth.onAuthStateChange(function (event, s) {
      if (event === "SIGNED_OUT") { session = null; me = null; renderAuth(); }
    });
    sb.auth.getSession().then(function (r) {
      session = r.data && r.data.session;
      if (!session) return renderAuth();
      return enter();
    }).catch(function (e) { renderAuth(e.message); });
    window.addEventListener("hashchange", function () { if (me) render(); });
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
  }
  function enter() {
    root.innerHTML = '<p class="hint" style="padding:40px 0">Loading…</p>';
    return sb.rpc("claim_student").then(function () { return null; }, function () { return null; })
      .then(function () { return sb.from("profiles").select("role,full_name").eq("id", session.user.id).maybeSingle(); })
      .then(function (r) {
        var p = unwrap(r); me = { id: session.user.id, email: session.user.email, role: p ? p.role : "student", name: p ? p.full_name : "" };
        return loadAll();
      }).then(function () {
        if (!location.hash || location.hash === "#") location.hash = me.role === "admin" ? "#/students" : "#/me";
        render();
      }).catch(function (e) { toast(e.message, true); renderAuth(e.message); });
  }

  function renderAuth(error) {
    var linkTab = UI.tab === "link";
    root.innerHTML = '<div class="auth">' + logo() +
      "<h1>Sign in to your academy</h1>" +
      '<div class="tabs" role="group" aria-label="Sign-in method"><button type="button" data-act="tab" data-v="link" aria-pressed="' + linkTab + '">Email me a link</button><button type="button" data-act="tab" data-v="pw" aria-pressed="' + !linkTab + '">Email and password</button></div>' +
      (UI.sent && linkTab
        ? '<p>We sent a sign-in link to <b>' + esc(UI.sent) + '</b>. Open it on this device. It works once.</p><button type="button" class="linkbtn" data-act="again">Use a different email</button>'
        : '<form data-form="signin" class="fields" style="grid-template-columns:1fr">' +
          '<div class="f"><label for="em">Email</label><input id="em" name="email" type="email" required autocomplete="email" inputmode="email"></div>' +
          (linkTab ? "" : '<div class="f"><label for="pw">Password</label><input id="pw" name="password" type="password" required autocomplete="current-password"></div>') +
          '<button class="btn" type="submit">' + (linkTab ? "Send me a sign-in link" : "Sign in") + "</button></form>") +
      (error ? '<p class="err" role="alert">' + esc(error) + "</p>" : "") +
      '<p class="hint">Students: use the email address you gave the academy. Need help? <a href="' + WHATSAPP + '" target="_blank" rel="noopener">WhatsApp us</a>.</p></div>';
  }

  function signOut() {
    sb.auth.signOut().then(function () { session = null; me = null; location.hash = ""; UI.sent = ""; renderAuth(); });
  }

  /* ------------------------------------------------------------ shell */
  function theme() { return document.documentElement.getAttribute("data-theme") || "light"; }
  function toggleTheme() {
    var t = theme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("clear-theme", t); } catch (e) { /* storage blocked */ }
    render();
  }
  function route() {
    var h = (location.hash || "").replace(/^#\/?/, "").split("/");
    return { name: h[0] || "", a: h[1] || "", b: h[2] || "" };
  }
  function shell(inner, current) {
    var admin = me.role === "admin";
    var nav = admin
      ? [["students", "Students"], ["lessons", "Lessons"], ["payments", "Payments"], ["account", "Account"]]
      : [["me", "My learning"]];
    return '<header class="top"><div class="who">' + logo() + '<span class="label">' + (admin ? "Admin" : "Student") + "</span></div>" +
      '<div class="right"><span class="hint">' + esc(me.email) + '</span><button type="button" class="iconbtn" data-act="theme" aria-label="Switch to ' + (theme() === "dark" ? "light" : "dark") + ' mode">' + (theme() === "dark" ? "&#9728;" : "&#9790;") + '</button><button type="button" class="btn sec sm" data-act="signout">Sign out</button></div></header>' +
      '<nav class="nav" aria-label="Sections">' + nav.map(function (n) {
        return '<button type="button" data-act="go" data-v="' + n[0] + '"' + (current === n[0] ? ' aria-current="page"' : "") + ">" + n[1] + "</button>";
      }).join("") + "</nav>" + inner;
  }
  function render() {
    if (!me) return renderAuth();
    var r = route();
    if (me.role !== "admin") { root.innerHTML = shell(viewMe(), "me"); return; }
    var html;
    if (r.name === "lessons") html = shell(viewLessons(), "lessons");
    else if (r.name === "payments") html = shell(viewPayments(), "payments");
    else if (r.name === "account") html = shell(viewAccount(), "account");
    else if (r.name === "report" && r.a) html = shell(viewReport(r.a, r.b === "edit"), "students");
    else html = shell(viewStudents(r.name === "students" ? r.a : ""), "students");
    root.innerHTML = html;
  }

  /* ------------------------------------------------------------ admin: students */
  function stats() {
    var now = new Date(), wk = new Date(now.getTime() + 7 * 86400000), mo = todayStr().slice(0, 7);
    var active = S.students.filter(function (s) { return s.status === "active"; }).length;
    var awaiting = S.packages.filter(function (p) { return p.status !== "cancelled" && p.status !== "expired" && !pkgIsPaid(p); }).length;
    var lw = S.lessons.filter(function (l) { var d = new Date(l.starts_at); return l.status === "scheduled" && d >= now && d <= wk; }).length;
    var usd = 0, egp = 0;
    S.payments.forEach(function (p) { if ((p.paid_on || "").slice(0, 7) === mo) { if (p.currency === "EGP") egp += Number(p.amount); else usd += Number(p.amount); } });
    return { active: active, awaiting: awaiting, lw: lw, usd: usd, egp: egp };
  }
  function statusPill(st) { return '<span class="pill' + (st === "active" ? " ok" : st === "lead" || st === "test" ? " warn" : "") + '">' + esc(STATUS[st] || st) + "</span>"; }
  function studentRows() {
    var q = UI.q.trim().toLowerCase();
    var list = S.students.filter(function (s) {
      if (UI.filter !== "all" && s.status !== UI.filter) return false;
      return !q || (s.full_name + " " + (s.email || "") + " " + (s.phone || "")).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) return '<div class="empty"><b>No students here yet</b>Add your first student, or change the filter.</div>';
    var cur = route().a;
    return list.map(function (s) {
      var pk = activePackage(s.id), used = pk ? pkgUsed(pk) : 0, tot = pk ? pk.lessons_total : 0;
      var unpaid = pk && !pkgIsPaid(pk);
      return '<button type="button" class="row" data-act="open" data-id="' + s.id + '"' + (cur === s.id ? ' aria-current="true"' : "") + ">" +
        '<span class="l1"><span class="nm">' + esc(s.full_name) + "</span>" + statusPill(s.status) + "</span>" +
        '<span class="meta">' + esc((PRICES[s.program] || {}).name || "No program yet") + (s.cefr ? " · " + esc(s.cefr) : "") + (s.country ? " · " + esc(s.country) : "") + "</span>" +
        (pk ? '<span class="bar" aria-hidden="true"><i style="width:' + Math.min(100, Math.round(used / (tot || 1) * 100)) + '%"></i></span><span class="meta">' + used + " of " + tot + " lessons" + (unpaid ? ' · <b style="color:var(--warn)">payment due</b>' : "") + "</span>" : "") +
        "</button>";
    }).join("");
  }
  function viewStudents(id) {
    var st = stats();
    var sum = '<div class="sum"><div><span class="label">Active students</span><b>' + st.active + '</b></div><div><span class="label">Payment due</span><b>' + st.awaiting + '</b></div><div><span class="label">Lessons, next 7 days</span><b>' + st.lw + '</b></div><div><span class="label">Income this month</span><b>' + money(st.usd) + (st.egp ? " + " + money(st.egp, "EGP") : "") + "</b></div></div>";
    var addBox = UI.add ? addStudentForm() : "";
    var left = '<div class="listcol"><div class="tools"><input type="search" id="q" placeholder="Search name, email or phone" aria-label="Search students" value="' + esc(UI.q) + '">' +
      '<select id="flt" aria-label="Filter by status"><option value="all">All statuses</option>' + opt(Object.keys(STATUS), UI.filter, STATUS) + "</select>" +
      '<button type="button" class="btn sm" data-act="addtoggle">' + (UI.add ? "Close" : "Add student") + "</button></div>" + addBox + '<div class="list" id="list">' + studentRows() + "</div></div>";
    var s = id ? byId(S.students, id) : null;
    var right = '<div class="panelcol">' + (s ? studentPanel(s) : '<div class="empty"><b>Select a student</b>Their profile, packages, payments, lessons and reports open here.</div>') + "</div>";
    return sum + '<div class="main' + (s ? " detail" : "") + '">' + left + right + "</div>";
  }
  function addStudentForm() {
    return '<form class="addbox" data-form="addstudent"><div class="fields">' +
      '<div class="f"><label for="an">Full name</label><input id="an" name="full_name" required></div>' +
      '<div class="f"><label for="ae">Email (their sign-in)</label><input id="ae" name="email" type="email"></div>' +
      '<div class="f"><label for="ap">WhatsApp</label><input id="ap" name="phone" inputmode="tel" placeholder="+20…"></div>' +
      '<div class="f"><label for="ac">Country</label><input id="ac" name="country"></div>' +
      '<div class="f"><label for="apr">Program</label><select id="apr" name="program"><option value="">Not chosen yet</option>' + opt(Object.keys(PRICES), "", mapNames()) + "</select></div>" +
      '<div class="f"><label for="ast">Status</label><select id="ast" name="status">' + opt(Object.keys(STATUS), "lead", STATUS) + "</select></div>" +
      '<div class="f wide"><label for="ag">Goal</label><textarea id="ag" name="goal"></textarea></div></div>' +
      '<div class="acts"><button class="btn" type="submit">Add student</button></div></form>';
  }
  function mapNames() { var o = {}; Object.keys(PRICES).forEach(function (k) { o[k] = PRICES[k].name; }); return o; }

  function studentPanel(s) {
    var pkgs = S.packages.filter(function (p) { return p.student_id === s.id; });
    var pays = S.payments.filter(function (p) { return p.student_id === s.id; });
    var les = S.lessons.filter(function (l) { return l.student_id === s.id; });
    var reps = S.reports.filter(function (r) { return r.student_id === s.id; });
    return '<div class="panel"><div class="acts noprint"><button type="button" class="btn sec sm back" data-act="back">Back to students</button></div>' +
      "<div><h2>" + esc(s.full_name) + '</h2><div class="pills" style="margin-top:8px">' + statusPill(s.status) + (s.user_id ? '<span class="pill ok">Has signed in</span>' : '<span class="pill">Not signed in yet</span>') + "</div></div>" +
      detailsSection(s) + packagesSection(s, pkgs, pays) + lessonsSection(s, pkgs, les) + reportsSection(s, reps) + notesSection(s) + dangerSection(s) + "</div>";
  }
  function detailsSection(s) {
    return '<div class="sec"><h3>Details</h3><form data-form="savestudent" data-id="' + s.id + '"><div class="fields">' +
      '<div class="f"><label for="d1">Full name</label><input id="d1" name="full_name" value="' + esc(s.full_name) + '" required></div>' +
      '<div class="f"><label for="d2">Email (their sign-in)</label><input id="d2" name="email" type="email" value="' + esc(s.email) + '"></div>' +
      '<div class="f"><label for="d3">WhatsApp</label><input id="d3" name="phone" value="' + esc(s.phone) + '"></div>' +
      '<div class="f"><label for="d4">Country</label><input id="d4" name="country" value="' + esc(s.country) + '"></div>' +
      '<div class="f"><label for="d5">Program</label><select id="d5" name="program"><option value="">Not chosen yet</option>' + opt(Object.keys(PRICES), s.program, mapNames()) + "</select></div>" +
      '<div class="f"><label for="d6">Level (CEFR)</label><select id="d6" name="cefr"><option value="">Not tested yet</option>' + opt(CEFR, s.cefr) + "</select></div>" +
      '<div class="f"><label for="d7">Status</label><select id="d7" name="status">' + opt(Object.keys(STATUS), s.status, STATUS) + "</select></div>" +
      '<div class="f wide"><label for="d8">Goal</label><textarea id="d8" name="goal">' + esc(s.goal) + "</textarea></div></div>" +
      '<div class="acts" style="margin-top:12px"><button class="btn" type="submit">Save details</button></div></form></div>';
  }

  /* ---- packages and payments */
  function packagesSection(s, pkgs, pays) {
    var cards = pkgs.map(function (p) {
      var used = pkgUsed(p), paid = pkgIsPaid(p), pp = pays.filter(function (x) { return x.package_id === p.id; });
      var rem = pkgRemaining(p, "USD");
      return '<div class="card"><div class="l1"><span class="t">' + esc(pkgLabel(p)) + '</span><span class="pills"><span class="pill ' + (paid ? "ok" : "warn") + '">' + (paid ? "Paid" : "Payment due") + '</span><span class="pill">' + esc(p.status) + "</span></span></div>" +
        '<span class="hint">' + money(p.price_usd) + (Number(p.discount_pct) ? " after " + Number(p.discount_pct) + "% discount (list " + money(p.list_price_usd) + ")" : "") + " · " + used + " of " + p.lessons_total + " lessons used" +
        (p.expires_on ? " · valid until " + esc(p.expires_on) : " · the 10 weeks start at the first lesson") + (p.pause_until ? " · paused until " + esc(p.pause_until) : "") + "</span>" +
        pp.map(function (x) {
          var open = UI.receipts[x.id];
          return '<div class="card"><div class="l1"><span><b>' + money(x.amount, x.currency) + "</b> · " + esc(x.method) + " · " + esc(x.paid_on) + '</span><span class="pills"><span class="pill ok">' + esc(x.receipt_no) + '</span><button type="button" class="btn sec sm" data-act="receipt" data-id="' + x.id + '">' + (open ? "Hide receipt" : "Receipt") + "</button></span></div>" +
            (open ? '<div class="receipt" id="rc-' + x.id + '">' + esc(receiptText(x, s, p)) + '</div><div class="acts"><button type="button" class="btn sm" data-act="copyr" data-id="' + x.id + '">Copy receipt</button><button type="button" class="btn sec sm" data-act="dlr" data-id="' + x.id + '">Download</button></div>' : "") + "</div>";
        }).join("") +
        (paid ? "" : '<form data-form="addpay" data-id="' + p.id + '" class="addbox"><div class="fields">' +
          '<div class="f"><label for="pa' + p.id + '">Amount received</label><input id="pa' + p.id + '" name="amount" type="number" step="0.01" min="0.01" required value="' + rem + '"></div>' +
          '<div class="f"><label for="pc' + p.id + '">Currency</label><select id="pc' + p.id + '" name="currency" data-change="paycur" data-id="' + p.id + '"><option>USD</option><option>EGP</option></select></div>' +
          '<div class="f"><label for="pm' + p.id + '">Method</label><select id="pm' + p.id + '" name="method">' + opt(METHODS, "InstaPay") + "</select></div>" +
          '<div class="f"><label for="pr' + p.id + '">Reference</label><input id="pr' + p.id + '" name="reference" placeholder="Transfer ID or last digits"></div>' +
          '<div class="f"><label for="pd' + p.id + '">Date received</label><input id="pd' + p.id + '" name="paid_on" type="date" value="' + todayStr() + '" required></div></div>' +
          '<div class="acts"><button class="btn" type="submit">Record payment and create receipt</button></div></form>') +
        '<div class="acts"><button type="button" class="btn danger sm" data-act="delpkg" data-id="' + p.id + '">Delete package</button></div></div>';
    }).join("");
    var prog = s.program || "general";
    return '<div class="sec"><h3>Packages and payments</h3><div class="cards">' + (cards || '<p class="hint">No package yet. Create one when the student chooses a program.</p>') + "</div>" +
      '<form data-form="addpkg" data-id="' + s.id + '" class="addbox"><div class="fields">' +
      '<div class="f"><label for="kp">Program</label><select id="kp" name="program" data-change="pkgprev">' + opt(Object.keys(PRICES), prog, mapNames()) + "</select></div>" +
      '<div class="f"><label for="kl">Levels</label><select id="kl" name="levels" data-change="pkgprev"><option value="1">1 level (8 lessons)</option><option value="2">2 levels (16 lessons), 8% off</option><option value="3">3 levels (24 lessons), 12% off</option></select></div></div>' +
      '<p class="hint" id="pkgprev">' + pkgPreview(prog, 1) + '</p><div class="acts"><button class="btn sec" type="submit">Create package</button></div></form></div>';
  }
  function pkgPreview(prog, levels) {
    var p = priceFor(prog, levels);
    return "Price: <b>" + money(p.usd) + "</b> (EGP " + p.egp.toLocaleString("en-US") + ")" + (p.off ? ", list " + money(p.list) : "");
  }
  function receiptText(pay, s, pkg) {
    return ["CLEAR English Academy", "Payment receipt", "",
      "Receipt no: " + pay.receipt_no, "Date: " + pay.paid_on, "Student: " + s.full_name,
      "Program: " + (pkg ? pkgLabel(pkg) : "-"), "Amount paid: " + money(pay.amount, pay.currency),
      "Method: " + pay.method + (pay.reference ? " (" + pay.reference + ")" : ""), "Issued by: " + ISSUER, "",
      "Terms: " + TERMS].join("\n");
  }

  /* ---- lessons */
  function lessonsSection(s, pkgs, les) {
    var rows = les.slice().sort(function (a, b) { return a.starts_at < b.starts_at ? 1 : -1; }).map(function (l) {
      return '<div class="card"><div class="l1"><span class="t">' + esc(fmtDT(l.starts_at)) + " · " + l.duration_min + ' min</span><select data-change="lstatus" data-id="' + l.id + '" aria-label="Lesson status" style="width:auto">' + opt(Object.keys(LSTATUS), l.status, LSTATUS) + "</select></div>" +
        '<form data-form="savelesson" data-id="' + l.id + '"><div class="fields"><div class="f"><label for="lt' + l.id + '">Topic</label><input id="lt' + l.id + '" name="topic" value="' + esc(l.topic) + '"></div>' +
        '<div class="f"><label for="lm' + l.id + '">Meeting link</label><input id="lm' + l.id + '" name="meeting_url" type="url" value="' + esc(l.meeting_url) + '"></div>' +
        '<div class="f wide"><label for="ls' + l.id + '">Note the student will see</label><textarea id="ls' + l.id + '" name="summary">' + esc(l.summary) + "</textarea></div></div>" +
        '<div class="acts" style="margin-top:8px"><button class="btn sec sm" type="submit">Save</button><button type="button" class="btn danger sm" data-act="dellesson" data-id="' + l.id + '">Delete</button></div></form></div>';
    }).join("");
    var start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 24);
    var opts = '<option value="">No package</option>' + pkgs.map(function (p) { return '<option value="' + p.id + '">' + esc(pkgLabel(p)) + "</option>"; }).join("");
    var ap = activePackage(s.id);
    return '<div class="sec"><h3>Lessons</h3><div class="cards">' + (rows || '<p class="hint">No lessons scheduled yet.</p>') + "</div>" +
      '<form data-form="addlesson" data-id="' + s.id + '" class="addbox"><div class="fields">' +
      '<div class="f"><label for="lw">Date and time</label><input id="lw" name="when" type="datetime-local" required value="' + localInputValue(start) + '"></div>' +
      '<div class="f"><label for="ld">Minutes</label><input id="ld" name="duration" type="number" min="15" max="180" step="5" value="60" required></div>' +
      '<div class="f"><label for="lp">Package</label><select id="lp" name="package_id">' + opts.replace('value="' + (ap ? ap.id : "") + '"', 'value="' + (ap ? ap.id : "") + '" selected') + "</select></div>" +
      '<div class="f"><label for="lto">Topic</label><input id="lto" name="topic"></div></div>' +
      '<p class="hint">The time is in your own time zone. Students see it in theirs.</p><div class="acts"><button class="btn sec" type="submit">Schedule lesson</button></div></form></div>';
  }

  /* ---- reports */
  function reportsSection(s, reps) {
    var rows = reps.map(function (r) {
      return '<div class="card"><div class="l1"><span class="t">' + esc(r.title || "Level report") + '</span><span class="pills"><span class="pill ' + (r.published ? "ok" : "warn") + '">' + (r.published ? "Published" : "Draft") + "</span>" + (r.cefr ? '<span class="pill">' + esc(r.cefr) + "</span>" : "") + "</span></div>" +
        '<div class="acts"><button type="button" class="btn sec sm" data-act="viewreport" data-id="' + r.id + '">View</button><button type="button" class="btn sec sm" data-act="editreport" data-id="' + r.id + '">Edit</button></div></div>';
    }).join("");
    return '<div class="sec"><h3>Feedback reports</h3><div class="cards">' + (rows || '<p class="hint">No report yet. Write one after the placement test.</p>') + '</div><button type="button" class="btn sec" data-act="newreport" data-id="' + s.id + '">New report</button></div>';
  }
  function notesSection(s) {
    return '<div class="sec"><h3>Private notes</h3><form data-form="savenote" data-id="' + s.id + '"><div class="f"><label for="nb" class="hint">Only you can read this. Students never see it.</label><textarea id="nb" name="body">' + esc(S.notes[s.id] || "") + '</textarea></div><div class="acts" style="margin-top:8px"><button class="btn sec sm" type="submit">Save notes</button></div></form></div>';
  }
  function dangerSection(s) {
    return '<div class="sec"><button type="button" class="btn danger sm" data-act="delstudent" data-id="' + s.id + '">Delete this student and all their records</button></div>';
  }

  /* ------------------------------------------------------------ admin: lessons board */
  function viewLessons() {
    var from = new Date(); from.setHours(0, 0, 0, 0);
    var up = S.lessons.filter(function (l) { return new Date(l.starts_at) >= from; }).sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; });
    if (!up.length) return '<div class="empty" style="margin-top:20px"><b>No upcoming lessons</b>Schedule lessons from a student\'s profile.</div>';
    var out = "", last = "";
    up.forEach(function (l) {
      var k = dayKey(l.starts_at);
      if (k !== last) { out += '<div class="day">' + esc(fmtDay(l.starts_at)) + "</div>"; last = k; }
      out += '<div class="lrow"><span class="tm">' + esc(fmtTime(l.starts_at)) + '</span><span><a href="#/students/' + l.student_id + '">' + esc(studentName(l.student_id)) + '</a><br><span class="sub">' + esc(l.topic || "No topic yet") + " · " + l.duration_min + ' min</span></span><select data-change="lstatus" data-id="' + l.id + '" aria-label="Lesson status" style="width:auto">' + opt(Object.keys(LSTATUS), l.status, LSTATUS) + "</select></div>";
    });
    return '<div style="margin-top:8px">' + out + "</div>";
  }

  /* ------------------------------------------------------------ admin: payments ledger */
  function viewPayments() {
    var pays = S.payments.slice().sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
    var usd = 0, egp = 0; pays.forEach(function (p) { if (p.currency === "EGP") egp += Number(p.amount); else usd += Number(p.amount); });
    var rows = pays.map(function (p) {
      return '<div class="lrow" style="grid-template-columns:110px minmax(0,1fr) auto"><span class="tm">' + esc(p.receipt_no) + '</span><span><a href="#/students/' + p.student_id + '">' + esc(studentName(p.student_id)) + '</a><br><span class="sub">' + esc(p.paid_on) + " · " + esc(p.method) + (p.reference ? " · " + esc(p.reference) : "") + '</span></span><b>' + money(p.amount, p.currency) + "</b></div>";
    }).join("");
    return '<div class="sum"><div><span class="label">Received in USD</span><b>' + money(usd) + '</b></div><div><span class="label">Received in EGP</span><b>' + money(egp, "EGP") + '</b></div><div><span class="label">Receipts issued</span><b>' + pays.length + "</b></div></div>" +
      (pays.length ? '<div class="acts" style="margin-bottom:12px"><button type="button" class="btn sec sm" data-act="csv">Download as CSV</button></div><div class="list">' + rows + "</div>" : '<div class="empty"><b>No payments yet</b>Record a payment from a student\'s package.</div>');
  }
  function exportCsv() {
    var head = ["receipt_no", "paid_on", "student", "amount", "currency", "method", "reference"];
    var lines = [head.join(",")].concat(S.payments.map(function (p) {
      return [p.receipt_no, p.paid_on, studentName(p.student_id), p.amount, p.currency, p.method, p.reference || ""].map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(",");
    }));
    download("clear-payments-" + todayStr() + ".csv", lines.join("\n"), "text/csv");
  }

  /* ------------------------------------------------------------ admin: account */
  function viewAccount() {
    return '<div class="panel" style="margin-top:20px;max-width:520px"><div><h2>Account</h2><p class="hint">Signed in as ' + esc(me.email) + '. Role: ' + esc(me.role) + '.</p></div>' +
      '<form data-form="setpw"><div class="f"><label for="np">Set a password</label><input id="np" name="password" type="password" minlength="8" autocomplete="new-password" required><span class="hint">At least 8 characters. Then you can sign in with email and password instead of waiting for an email.</span></div><div class="acts" style="margin-top:10px"><button class="btn" type="submit">Save password</button></div></form></div>';
  }

  /* ------------------------------------------------------------ reports: view and editor */
  function reportHTML(r, s) {
    var lvlIdx = CEFR.indexOf(r.cefr);
    var scale = '<div class="scale"><div class="bars">' + CEFR.map(function (c, i) { return "<i" + (i === lvlIdx ? ' class="on"' : "") + "></i>"; }).join("") + '</div><div class="names">' + CEFR.map(function (c) { return "<span>" + c + "</span>"; }).join("") + "</div></div>";
    var skills = (r.skills || []).filter(function (k) { return k.can_do || k.next_step; }).map(function (k) {
      return '<div class="skill"><h4>' + esc(k.skill) + "</h4>" + (k.can_do ? '<p class="can"><b>&#10003; Can do</b> ' + esc(k.can_do) + "</p>" : "") + (k.next_step ? '<p class="next"><b>Next step:</b> ' + esc(k.next_step) + "</p>" : "") + "</div>";
    }).join("");
    var recs = (r.recommendations || []).filter(function (k) { return k.text; }).map(function (k) { return "<li><b>" + esc(k.area) + ":</b> " + esc(k.text) + "</li>"; }).join("");
    var objs = (r.objectives || []).map(function (o) { return "<li>" + esc(o) + "</li>"; }).join("");
    var plan = (r.plan || []).map(function (p, i) { return "<div><b>" + (i + 1) + "</b><span>" + esc(p) + "</span></div>"; }).join("");
    return '<article class="report"><div class="rtop">' + logo() + '<span class="label">' + esc(r.kind === "progress" ? "Progress report" : r.kind === "final" ? "Final report" : "Level report") + "</span></div>" +
      "<div><h2>" + esc(s.full_name) + '</h2><p class="hint">' + esc(r.title || "") + (r.title ? " · " : "") + esc((PRICES[s.program] || {}).name || "") + "</p></div>" +
      (r.cefr ? '<div class="lvl"><div class="badge"><div class="label">Your level</div><div class="code">' + esc(r.cefr) + "</div></div>" + scale + "</div>" : "") +
      (r.summary ? "<div><h3>Summary</h3><p>" + esc(r.summary) + "</p></div>" : "") +
      (r.goals ? "<div><h3>Your goals</h3><p>" + esc(r.goals) + "</p></div>" : "") +
      (skills ? "<div><h3>Skills</h3>" + skills + "</div>" : "") +
      (recs ? "<div><h3>Recommendations</h3><ul>" + recs + "</ul></div>" : "") +
      (objs ? "<div><h3>Level objectives</h3><ol>" + objs + "</ol></div>" : "") +
      (plan ? '<div><h3>Lesson plan</h3><div class="plan">' + plan + "</div></div>" : "") +
      '<p class="rfoot">Assessed by ' + esc(r.assessed_by || "CLEAR Academic Team") + (r.published_at ? " · " + esc(new Date(r.published_at).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })) : "") + "</p></article>";
  }
  function viewReport(id, edit) {
    var r = byId(S.reports, id), s;
    if (UI.draft && UI.draft.id === id) { r = UI.draft; }
    if (!r) return '<div class="empty" style="margin-top:20px"><b>Report not found</b><button type="button" class="btn sec sm" data-act="go" data-v="students">Back to students</button></div>';
    s = byId(S.students, r.student_id) || { full_name: "Student" };
    var bar = '<div class="acts noprint" style="margin:18px 0"><button type="button" class="btn sec sm" data-act="open" data-id="' + r.student_id + '">Back to ' + esc(s.full_name) + "</button>" +
      (edit ? "" : '<button type="button" class="btn sec sm" data-act="editreport" data-id="' + r.id + '">Edit</button><button type="button" class="btn sm" data-act="print">Print or save as PDF</button>') + "</div>";
    return bar + (edit ? reportEditor(r, s) : reportHTML(r, s));
  }
  function reportEditor(r, s) {
    var skills = SKILLS.map(function (name, i) {
      var k = (r.skills || []).filter(function (x) { return x.skill === name; })[0] || {};
      return '<div class="card"><div class="t">' + name + '</div><div class="fields"><div class="f"><label for="sc' + i + '">Can do</label><textarea id="sc' + i + '" name="can_' + i + '">' + esc(k.can_do) + '</textarea></div><div class="f"><label for="sn' + i + '">Next step</label><textarea id="sn' + i + '" name="next_' + i + '">' + esc(k.next_step) + "</textarea></div></div></div>";
    }).join("");
    var recs = (r.recommendations || []).map(function (k, i) {
      return '<div class="card"><div class="fields"><div class="f"><label for="ra' + i + '">Area</label><input id="ra' + i + '" name="rec_area_' + i + '" value="' + esc(k.area) + '"></div><div class="f wide"><label for="rt' + i + '">Recommendation</label><textarea id="rt' + i + '" name="rec_text_' + i + '">' + esc(k.text) + "</textarea></div></div></div>";
    }).join("");
    return '<form data-form="savereport" data-id="' + r.id + '" class="panel"><div><h2>Report for ' + esc(s.full_name) + '</h2><p class="hint">Students see a report only after you publish it.</p></div>' +
      '<div class="fields"><div class="f"><label for="rk">Type</label><select id="rk" name="kind">' + opt(["placement", "progress", "final"], r.kind, { placement: "Placement test", progress: "Progress", final: "Final" }) + "</select></div>" +
      '<div class="f"><label for="rti">Title</label><input id="rti" name="title" value="' + esc(r.title) + '"></div>' +
      '<div class="f"><label for="rc">Level</label><select id="rc" name="cefr"><option value="">Not set</option>' + opt(CEFR, r.cefr) + "</select></div>" +
      '<div class="f"><label for="rb">Assessed by</label><input id="rb" name="assessed_by" value="' + esc(r.assessed_by || "CLEAR Academic Team") + '"></div>' +
      '<div class="f wide"><label for="rs">Summary</label><textarea id="rs" name="summary">' + esc(r.summary) + '</textarea></div><div class="f wide"><label for="rg">Goals</label><textarea id="rg" name="goals">' + esc(r.goals) + "</textarea></div></div>" +
      '<div class="sec"><h3>Skills</h3><div class="cards">' + skills + '</div></div><div class="sec"><h3>Recommendations</h3><div class="cards">' + recs + '</div><button type="button" class="btn sec sm" data-act="addrec">Add a recommendation</button></div>' +
      '<div class="sec"><h3>Level objectives</h3><div class="f"><label class="hint" for="ro">One objective per line</label><textarea id="ro" name="objectives" style="min-height:140px">' + esc((r.objectives || []).join("\n")) + "</textarea></div></div>" +
      '<div class="sec"><h3>Lesson plan</h3><div class="f"><label class="hint" for="rp">One lesson per line</label><textarea id="rp" name="plan" style="min-height:180px">' + esc((r.plan || []).join("\n")) + "</textarea></div></div>" +
      '<div class="acts"><button class="btn sec" type="submit" data-pub="0">' + (r.published ? "Unpublish and save" : "Save draft") + '</button>' + (r.published ? '<button class="btn" type="submit" data-pub="1">Save changes</button>' : '<button class="btn" type="submit" data-pub="1">Save and publish to the student</button>') + '<button type="button" class="btn danger" data-act="delreport" data-id="' + r.id + '">Delete</button></div></form>';
  }
  function collectReport(form, base) {
    var f = new FormData(form), g = function (k) { return (f.get(k) || "").toString(); };
    var lines = function (k) { return g(k).split("\n").map(function (x) { return x.trim(); }).filter(Boolean); };
    var recs = [], i = 0;
    while (f.has("rec_area_" + i)) { recs.push({ area: g("rec_area_" + i).trim(), text: g("rec_text_" + i).trim() }); i++; }
    return Object.assign({}, base, {
      kind: g("kind"), title: g("title").trim(), cefr: g("cefr") || null, assessed_by: g("assessed_by").trim() || "CLEAR Academic Team",
      summary: g("summary").trim(), goals: g("goals").trim(),
      skills: SKILLS.map(function (n, j) { return { skill: n, can_do: g("can_" + j).trim(), next_step: g("next_" + j).trim() }; }),
      recommendations: recs, objectives: lines("objectives"), plan: lines("plan")
    });
  }

  /* ------------------------------------------------------------ student view */
  function viewMe() {
    var s = S.students[0];
    if (!s) {
      return '<div class="empty" style="margin-top:24px"><b>We could not find your record yet</b>You signed in as ' + esc(me.email) + '. Please use the same email address you gave the academy, or <a href="' + WHATSAPP + '" target="_blank" rel="noopener">message us on WhatsApp</a>.</div>';
    }
    var now = new Date();
    var upcoming = S.lessons.filter(function (l) { return l.student_id === s.id && l.status === "scheduled" && new Date(l.starts_at) >= now; });
    var past = S.lessons.filter(function (l) { return l.student_id === s.id && (new Date(l.starts_at) < now || l.status !== "scheduled"); }).sort(function (a, b) { return a.starts_at < b.starts_at ? 1 : -1; });
    var reps = S.reports.filter(function (r) { return r.student_id === s.id; });
    var pkgs = S.packages.filter(function (p) { return p.student_id === s.id; });
    var pays = S.payments.filter(function (p) { return p.student_id === s.id; });
    var next = upcoming[0];
    return '<div style="margin-top:20px;display:grid;gap:22px">' +
      '<div class="sum" style="margin:0"><div><span class="label">Hello</span><b>' + esc(s.full_name.split(" ")[0]) + '</b></div><div><span class="label">Your level</span><b>' + esc(s.cefr || "To be tested") + '</b></div><div><span class="label">Next lesson</span><b style="font-size:17px">' + (next ? esc(fmtDT(next.starts_at, true)) : "Not scheduled yet") + "</b></div></div>" +
      '<div class="panel"><div class="sec"><h3>Your lessons</h3><div class="cards">' + (upcoming.concat(past).length ? upcoming.concat(past).map(function (l) {
        return '<div class="card"><div class="l1"><span class="t">' + esc(fmtDT(l.starts_at, true)) + " · " + l.duration_min + ' min</span><span class="pill' + (l.status === "completed" ? " ok" : "") + '">' + esc(LSTATUS[l.status]) + "</span></div>" +
          (l.topic ? '<span class="hint">' + esc(l.topic) + "</span>" : "") + (l.summary ? "<p>" + esc(l.summary) + "</p>" : "") +
          (l.meeting_url && l.status === "scheduled" ? '<div class="acts"><a class="btn sm" href="' + esc(l.meeting_url) + '" target="_blank" rel="noopener">Join lesson</a></div>' : "") + "</div>";
      }).join("") : '<p class="hint">Your lessons will appear here once they are scheduled.</p>') + "</div>" +
      '<p class="hint">To move a lesson, message the academy at least 24 hours before it starts. <a href="' + WHATSAPP + '" target="_blank" rel="noopener">WhatsApp the academy</a>.</p></div>' +
      (pkgs.length ? '<div class="sec"><h3>Your package</h3><div class="cards">' + pkgs.map(function (p) {
        return '<div class="card"><div class="l1"><span class="t">' + esc(pkgLabel(p)) + '</span><span class="pill ' + (pkgIsPaid(p) ? "ok" : "warn") + '">' + (pkgIsPaid(p) ? "Paid" : "Payment due") + '</span></div><span class="hint">' + pkgUsed(p) + " of " + p.lessons_total + " lessons used" + (p.expires_on ? " · valid until " + esc(p.expires_on) : "") + "</span></div>";
      }).join("") + "</div></div>" : "") +
      (pays.length ? '<div class="sec"><h3>Your receipts</h3><div class="cards">' + pays.map(function (x) {
        var open = UI.receipts[x.id], pkg = byId(pkgs, x.package_id);
        return '<div class="card"><div class="l1"><span><b>' + money(x.amount, x.currency) + "</b> · " + esc(x.paid_on) + '</span><span class="pills"><span class="pill ok">' + esc(x.receipt_no) + '</span><button type="button" class="btn sec sm" data-act="receipt" data-id="' + x.id + '">' + (open ? "Hide" : "Show") + "</button></span></div>" +
          (open ? '<div class="receipt" id="rc-' + x.id + '">' + esc(receiptText(x, s, pkg)) + '</div><div class="acts"><button type="button" class="btn sm" data-act="copyr" data-id="' + x.id + '">Copy</button></div>' : "") + "</div>";
      }).join("") + "</div></div>" : "") + "</div>" +
      (reps.length ? '<div><h3 style="margin-bottom:12px">Your reports</h3><div style="display:grid;gap:16px">' + reps.map(function (r) { return reportHTML(r, s); }).join("") + '</div><div class="acts noprint" style="margin-top:12px"><button type="button" class="btn sm" data-act="print">Print or save as PDF</button></div></div>' : "") + "</div>";
  }

  /* ------------------------------------------------------------ events */
  function formData(form) { var o = {}; new FormData(form).forEach(function (v, k) { o[k] = typeof v === "string" ? v.trim() : v; }); return o; }
  function nul(v) { return v === "" || v == null ? null : v; }

  function onInput(e) {
    if (e.target.id === "q") { UI.q = e.target.value; $("#list").innerHTML = studentRows(); }
  }
  function onChange(e) {
    var t = e.target, ch = t.getAttribute("data-change");
    if (t.id === "flt") { UI.filter = t.value; $("#list").innerHTML = studentRows(); return; }
    if (ch === "pkgprev") {
      var f = t.form; $("#pkgprev").innerHTML = pkgPreview(f.program.value, parseInt(f.levels.value, 10)); return;
    }
    if (ch === "paycur") {
      var pkg = byId(S.packages, t.getAttribute("data-id"));
      if (pkg) t.form.amount.value = pkgRemaining(pkg, t.value);
      return;
    }
    if (ch === "lstatus") {
      var id = t.getAttribute("data-id"), l = byId(S.lessons, id);
      act(sb.from("lessons").update({ status: t.value }).eq("id", id), "Lesson updated.").then(function () {
        return maybeCompletePackage(l && l.package_id);
      }).then(refresh, refresh);
    }
  }
  function maybeCompletePackage(pkgId) {
    if (!pkgId) return Promise.resolve();
    return loadAll().then(function () {
      var p = byId(S.packages, pkgId);
      if (p && p.status === "active" && pkgUsed(p) >= p.lessons_total) return act(sb.from("packages").update({ status: "completed" }).eq("id", pkgId), "All lessons used. Package marked completed.");
    });
  }

  function onClick(e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    var a = b.getAttribute("data-act"), id = b.getAttribute("data-id"), v = b.getAttribute("data-v");
    if (a === "tab") { UI.tab = v; UI.sent = ""; return renderAuth(); }
    if (a === "again") { UI.sent = ""; return renderAuth(); }
    if (a === "theme") return toggleTheme();
    if (a === "signout") return signOut();
    if (a === "go") { location.hash = "#/" + v; return; }
    if (a === "open") { location.hash = "#/students/" + id; return; }
    if (a === "back") { location.hash = "#/students"; return; }
    if (a === "addtoggle") { UI.add = !UI.add; return render(); }
    if (a === "print") return window.print();
    if (a === "csv") return exportCsv();
    if (a === "receipt") { UI.receipts[id] = !UI.receipts[id]; return render(); }
    if (a === "copyr") { var el = $("#rc-" + id); return copyText(el ? el.textContent : ""); }
    if (a === "dlr") { var p = byId(S.payments, id), s = p && byId(S.students, p.student_id); if (p && s) download(p.receipt_no + "-" + s.full_name.replace(/[^\w]+/g, "-") + ".txt", receiptText(p, s, byId(S.packages, p.package_id))); return; }
    if (a === "viewreport") { UI.draft = null; location.hash = "#/report/" + id; return; }
    if (a === "editreport") { UI.draft = null; location.hash = "#/report/" + id + "/edit"; return; }
    if (a === "newreport") return newReport(id);
    if (a === "addrec") { var form = $('form[data-form="savereport"]'); var cur = byId(S.reports, form.getAttribute("data-id")) || UI.draft; UI.draft = collectReport(form, cur); UI.draft.recommendations.push({ area: "", text: "" }); return render(); }
    if (a === "delreport") return ask("Delete this report? This cannot be undone.", "Delete").then(function (ok) {
      if (ok) act(sb.from("reports").delete().eq("id", id), "Report deleted.").then(function () { var r = byId(S.reports, id); UI.draft = null; location.hash = "#/students/" + (r ? r.student_id : ""); return refresh(); });
    });
    if (a === "delpkg") return ask("Delete this package and its payment records? Receipts stay numbered, so keep a copy first.", "Delete package").then(function (ok) {
      if (ok) act(sb.from("packages").delete().eq("id", id), "Package deleted.").then(refresh);
    });
    if (a === "dellesson") return ask("Delete this lesson?", "Delete").then(function (ok) {
      if (ok) act(sb.from("lessons").delete().eq("id", id), "Lesson deleted.").then(refresh);
    });
    if (a === "delstudent") return ask("Delete this student with all packages, payments, lessons and reports? This cannot be undone.", "Delete student").then(function (ok) {
      if (ok) act(sb.from("students").delete().eq("id", id), "Student deleted.").then(function () { location.hash = "#/students"; return refresh(); });
    });
  }

  function newReport(studentId) {
    var s = byId(S.students, studentId);
    var row = {
      student_id: studentId, kind: "placement", title: "Level report", cefr: s.cefr || null, goals: s.goal || "", summary: "", assessed_by: "CLEAR Academic Team",
      skills: SKILLS.map(function (n) { return { skill: n, can_do: "", next_step: "" }; }),
      recommendations: RECS.map(function (n) { return { area: n, text: "" }; }), objectives: [], plan: [], published: false
    };
    act(sb.from("reports").insert(row).select().single(), "Draft created.").then(function (r) { return loadAll().then(function () { location.hash = "#/report/" + r.id + "/edit"; }); });
  }

  function onSubmit(e) {
    var form = e.target, kind = form.getAttribute("data-form"); if (!kind) return;
    e.preventDefault();
    var id = form.getAttribute("data-id"), d = formData(form), btn = form.querySelector('button[type="submit"]');
    if (kind === "signin") return doSignIn(d);
    if (btn) btn.disabled = true;
    var done = function () { if (btn) btn.disabled = false; };
    if (kind === "addstudent") {
      act(sb.from("students").insert({ full_name: d.full_name, email: nul(d.email), phone: nul(d.phone), country: nul(d.country), program: nul(d.program), status: d.status, goal: nul(d.goal) }).select().single(), "Student added.")
        .then(function (r) { UI.add = false; return loadAll().then(function () { location.hash = "#/students/" + r.id; render(); }); }).then(done, done);
    } else if (kind === "savestudent") {
      act(sb.from("students").update({ full_name: d.full_name, email: nul(d.email), phone: nul(d.phone), country: nul(d.country), program: nul(d.program), cefr: nul(d.cefr), status: d.status, goal: nul(d.goal) }).eq("id", id), "Saved.").then(refresh).then(done, done);
    } else if (kind === "savenote") {
      act(sb.from("student_notes").upsert({ student_id: id, body: d.body, updated_at: new Date().toISOString() }), "Notes saved.").then(refresh).then(done, done);
    } else if (kind === "addpkg") {
      var levels = parseInt(d.levels, 10), pr = priceFor(d.program, levels);
      act(sb.from("packages").insert({ student_id: id, program: d.program, levels: levels, lessons_total: levels * 8, list_price_usd: pr.list, discount_pct: Math.round(pr.off * 100), price_usd: pr.usd, status: "pending" }), "Package created.").then(function () {
        var s = byId(S.students, id);
        if (s && !s.program) return sb.from("students").update({ program: d.program }).eq("id", id);
      }).then(refresh).then(done, done);
    } else if (kind === "addpay") {
      addPayment(id, d).then(done, done);
    } else if (kind === "addlesson") {
      var when = new Date(d.when);
      if (isNaN(when.getTime())) { toast("Choose a date and time.", true); return done(); }
      act(sb.from("lessons").insert({ student_id: id, package_id: nul(d.package_id), starts_at: when.toISOString(), duration_min: parseInt(d.duration, 10) || 60, topic: nul(d.topic) }), "Lesson scheduled.").then(function () {
        var p = byId(S.packages, d.package_id);
        if (p && !p.starts_on) {
          var day = localInputValue(when).slice(0, 10);
          return sb.from("packages").update({ starts_on: day, expires_on: addDays(day, 70), status: p.status === "pending" ? "pending" : "active" }).eq("id", p.id);
        }
      }).then(refresh).then(done, done);
    } else if (kind === "savelesson") {
      act(sb.from("lessons").update({ topic: nul(d.topic), meeting_url: nul(d.meeting_url), summary: nul(d.summary) }).eq("id", id), "Lesson saved.").then(refresh).then(done, done);
    } else if (kind === "savereport") {
      var pub = e.submitter && e.submitter.getAttribute("data-pub") === "1";
      var base = byId(S.reports, id) || UI.draft, rep = collectReport(form, base);
      var wasPub = base.published;
      rep.published = e.submitter && e.submitter.getAttribute("data-pub") === "1" ? true : (wasPub ? false : false);
      var up = { kind: rep.kind, title: rep.title, cefr: rep.cefr, assessed_by: rep.assessed_by, summary: rep.summary, goals: rep.goals, skills: rep.skills, recommendations: rep.recommendations, objectives: rep.objectives, plan: rep.plan, published: rep.published };
      act(sb.from("reports").update(up).eq("id", id), rep.published ? "Saved and published." : "Saved as draft.").then(function () { UI.draft = null; return loadAll(); }).then(function () { location.hash = "#/report/" + id; render(); }).then(done, done);
    } else if (kind === "setpw") {
      act(sb.auth.updateUser({ password: d.password }), "Password saved. You can now sign in with email and password.").then(function () { form.reset(); }).then(done, done);
    }
  }

  function addPayment(pkgId, d) {
    var pkg = byId(S.packages, pkgId), amount = Number(d.amount);
    if (!pkg || !(amount > 0)) { toast("Enter the amount received.", true); return Promise.resolve(); }
    return act(sb.from("payments").insert({ student_id: pkg.student_id, package_id: pkgId, amount: amount, currency: d.currency, method: d.method, reference: nul(d.reference), paid_on: d.paid_on }).select().single(), null).then(function (pay) {
      return loadAll().then(function () {
        var p2 = byId(S.packages, pkgId), s = byId(S.students, pkg.student_id), jobs = [];
        if (p2 && p2.status === "pending" && pkgIsPaid(p2)) jobs.push(sb.from("packages").update({ status: "active" }).eq("id", pkgId));
        if (s && (s.status === "lead" || s.status === "test") && pkgIsPaid(p2)) jobs.push(sb.from("students").update({ status: "active" }).eq("id", s.id));
        return Promise.all(jobs);
      }).then(function () { UI.receipts[pay.id] = true; toast("Payment recorded. Receipt " + pay.receipt_no + "."); return refresh(); });
    });
  }

  function doSignIn(d) {
    var btn = $('form[data-form="signin"] button[type="submit"]'); if (btn) btn.disabled = true;
    var fail = function (msg) { renderAuth(msg); };
    if (UI.tab === "link") {
      sb.auth.signInWithOtp({ email: d.email, options: { emailRedirectTo: location.origin + location.pathname } }).then(function (r) {
        if (r.error) return fail(r.error.message);
        UI.sent = d.email; renderAuth();
      }, function (er) { fail(er.message); });
    } else {
      sb.auth.signInWithPassword({ email: d.email, password: d.password }).then(function (r) {
        if (r.error) return fail(r.error.message === "Invalid login credentials" ? "That email and password do not match. If you never set a password, use the email link." : r.error.message);
        session = r.data.session; return enter();
      }, function (er) { fail(er.message); });
    }
  }

  /* ------------------------------------------------------------ start */
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.__clear = { esc: esc, priceFor: priceFor };
})();
