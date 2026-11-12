/* CLEAR English Academy: academy app. Admin runs the academy; a student sees only their own lessons, receipts and published reports.
   Data and security live in Supabase (row-level security). This file is the interface only. */
(function () {
  "use strict";

  /* ------------------------------------------------------------ settings */
  /* Prices are fixed in dollars per level (8 one-hour lessons). EGP prices follow the saved exchange rate. */
  var PRICES = {
    general:        { name: "General English",        ar: "الإنجليزية العامة",                usd: 79,  mins: 60 },
    business:       { name: "Business English",       ar: "إنجليزية الأعمال",                 usd: 99,  mins: 60 },
    conversation:   { name: "Conversation",           ar: "المحادثة",                         usd: 119, mins: 60 },
    esp:            { name: "ESP",                    ar: "الإنجليزية لأغراض خاصة (ESP)",     usd: 139, mins: 60 },
    ielts_general:  { name: "IELTS General Training", ar: "آيلتس (General Training)",         usd: 179, mins: 120 },
    ielts_academic: { name: "IELTS Academic",         ar: "آيلتس (Academic)",                 usd: 219, mins: 120 }
  };
  function progMins(k) { return (PRICES[k] && PRICES[k].mins) || 60; }
  var DEFAULT_RATE = 50.6329;
  var SETUP_SQL = "alter table public.settings\n  add column if not exists instapay text,\n  add column if not exists rate_updated_at timestamptz,\n  add column if not exists rate_source text;";
  /* free exchange-rate services that answer browser requests; the first that works is used */
  var RATE_SOURCES = [
    { name: "open.er-api.com", url: "https://open.er-api.com/v6/latest/USD", pick: function (j) { return j && j.rates && j.rates.EGP; } },
    { name: "exchangerate-api.com", url: "https://api.exchangerate-api.com/v4/latest/USD", pick: function (j) { return j && j.rates && j.rates.EGP; } },
    { name: "currency-api (jsDelivr)", url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", pick: function (j) { return j && j.usd && j.usd.egp; } }
  ];
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
  var CONTACT_EMAIL = "clearacademy7@gmail.com";
  var MKINDS = { slides: "Slides", handout: "Handout", worksheet: "Worksheet", homework: "Homework", recording: "Recording", other: "Other" };
  var MAX_FILE = 50 * 1024 * 1024;
  var EXT_MIME = {
    pdf: "application/pdf", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", txt: "text/plain",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4",
    opus: "audio/ogg", ogg: "audio/ogg", aac: "audio/aac", amr: "audio/amr", webm: "audio/webm"
  };
  var FILE_ACCEPT = Object.keys(EXT_MIME).map(function (e) { return "." + e; }).join(",");
  var DOWS = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [0, "Sunday"]];
  /* name, dial code, main time zone */
  var COUNTRIES = [
    ["Egypt", "+20", "Africa/Cairo"], ["Saudi Arabia", "+966", "Asia/Riyadh"], ["United Arab Emirates", "+971", "Asia/Dubai"], ["Kuwait", "+965", "Asia/Kuwait"],
    ["Qatar", "+974", "Asia/Qatar"], ["Bahrain", "+973", "Asia/Bahrain"], ["Oman", "+968", "Asia/Muscat"], ["Jordan", "+962", "Asia/Amman"],
    ["Lebanon", "+961", "Asia/Beirut"], ["Iraq", "+964", "Asia/Baghdad"], ["Syria", "+963", "Asia/Damascus"], ["Palestine", "+970", "Asia/Gaza"],
    ["Yemen", "+967", "Asia/Aden"], ["Libya", "+218", "Africa/Tripoli"], ["Tunisia", "+216", "Africa/Tunis"], ["Algeria", "+213", "Africa/Algiers"],
    ["Morocco", "+212", "Africa/Casablanca"], ["Sudan", "+249", "Africa/Khartoum"], ["Somalia", "+252", "Africa/Mogadishu"], ["Turkey", "+90", "Europe/Istanbul"],
    ["Iran", "+98", "Asia/Tehran"], ["Pakistan", "+92", "Asia/Karachi"], ["India", "+91", "Asia/Kolkata"], ["Bangladesh", "+880", "Asia/Dhaka"],
    ["Indonesia", "+62", "Asia/Jakarta"], ["Malaysia", "+60", "Asia/Kuala_Lumpur"], ["Singapore", "+65", "Asia/Singapore"], ["Philippines", "+63", "Asia/Manila"],
    ["China", "+86", "Asia/Shanghai"], ["Japan", "+81", "Asia/Tokyo"], ["South Korea", "+82", "Asia/Seoul"], ["Australia", "+61", "Australia/Sydney"],
    ["New Zealand", "+64", "Pacific/Auckland"], ["United Kingdom", "+44", "Europe/London"], ["Ireland", "+353", "Europe/Dublin"], ["France", "+33", "Europe/Paris"],
    ["Germany", "+49", "Europe/Berlin"], ["Italy", "+39", "Europe/Rome"], ["Spain", "+34", "Europe/Madrid"], ["Portugal", "+351", "Europe/Lisbon"],
    ["Netherlands", "+31", "Europe/Amsterdam"], ["Belgium", "+32", "Europe/Brussels"], ["Switzerland", "+41", "Europe/Zurich"], ["Austria", "+43", "Europe/Vienna"],
    ["Sweden", "+46", "Europe/Stockholm"], ["Norway", "+47", "Europe/Oslo"], ["Denmark", "+45", "Europe/Copenhagen"], ["Greece", "+30", "Europe/Athens"],
    ["Cyprus", "+357", "Asia/Nicosia"], ["Poland", "+48", "Europe/Warsaw"], ["Ukraine", "+380", "Europe/Kyiv"], ["Russia", "+7", "Europe/Moscow"],
    ["Canada", "+1", "America/Toronto"], ["United States", "+1", "America/New_York"], ["Mexico", "+52", "America/Mexico_City"], ["Brazil", "+55", "America/Sao_Paulo"],
    ["Argentina", "+54", "America/Argentina/Buenos_Aires"], ["South Africa", "+27", "Africa/Johannesburg"], ["Nigeria", "+234", "Africa/Lagos"],
    ["Kenya", "+254", "Africa/Nairobi"], ["Ethiopia", "+251", "Africa/Addis_Ababa"]
  ];

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
  /* every lesson time is Egypt time; students can convert it to their own zone */
  var EG = "Africa/Cairo";
  function fmtDT(iso, tz) {
    return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz || EG });
  }
  function fmtDay(iso) { return new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: EG }); }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: EG }); }
  function dayKey(iso) { return new Date(iso).toLocaleDateString("en-CA", { timeZone: EG }); }
  /* value for a datetime-local box, read as Egypt time */
  function localInputValue(date) {
    var o = {}; new Intl.DateTimeFormat("en-US", { timeZone: EG, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date).forEach(function (x) { o[x.type] = x.value; });
    return o.year + "-" + o.month + "-" + o.day + "T" + o.hour + ":" + o.minute;
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
    var old = function () {                       // older browsers: select a hidden box and copy
      try {
        var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta); ta.select(); var ok = document.execCommand && document.execCommand("copy"); ta.remove();
        if (ok) { toast("Copied."); return true; }
      } catch (e) { /* fall through */ }
      return false;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { toast("Copied."); }, function () { if (!old()) toast("Copy blocked by the browser. Select the text and copy.", true); });
    }
    if (!old()) toast("Copy is not available here. Select the text and copy.", true);
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

  function downloadBlob(name, blob) {
    try {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    } catch (e) { toast("Download is not available here.", true); }
  }

  /* ---- countries, phone numbers, time zones */
  function countryByName(n) { return COUNTRIES.filter(function (c) { return c[0] === n; })[0] || null; }
  function countryTz(n) { var c = countryByName(n); return c ? c[2] : null; }
  function countryOptions(sel) {
    var list = COUNTRIES.map(function (c) { return c[0]; });
    if (sel && list.indexOf(sel) < 0) list.unshift(sel);          // keep an older free-text value
    return '<option value="">Choose a country</option>' + opt(list, sel);
  }
  var DIALS = COUNTRIES.map(function (c) { return c[1]; }).filter(function (d, i, a) { return a.indexOf(d) === i; });
  function dialOptions(sel) {
    return COUNTRIES.map(function (c) { return c; }).filter(function (c, i, a) { return a.map(function (x) { return x[1]; }).indexOf(c[1]) === i; })
      .sort(function (a, b) { return a[0] < b[0] ? -1 : 1; })
      .map(function (c) { return '<option value="' + c[1] + '"' + (c[1] === sel ? " selected" : "") + ">" + esc(c[1] + " " + c[0]) + "</option>"; }).join("");
  }
  function splitPhone(phone, country) {
    var p = String(phone || "").trim(), c = countryByName(country), dial = c ? c[1] : "+20";
    if (/^(\+|00)/.test(p)) {
      var digits = p.replace(/^(\+|00)/, "").replace(/\D/g, ""), best = null;
      DIALS.forEach(function (d) { if (digits.indexOf(d.slice(1)) === 0 && (!best || d.length > best.length)) best = d; });
      if (best) return { dial: best, num: digits.slice(best.length - 1) };
    }
    return { dial: dial, num: p.replace(/\D/g, "") };
  }
  function joinPhone(dial, num) {
    var digits = String(num || "").replace(/\D/g, "").replace(/^0+/, "");
    return digits ? dial + " " + digits : null;
  }
  function waLink(phone) { var d = String(phone || "").replace(/\D/g, ""); return d ? "https://wa.me/" + d : ""; }
  function contactFields(pre, s) {
    s = s || {};
    var ph = splitPhone(s.phone, s.country);
    return '<div class="f"><label for="' + pre + 'c">Country</label><select id="' + pre + 'c" name="country" data-change="country">' + countryOptions(s.country || "") + "</select></div>" +
      '<div class="f wide"><label for="' + pre + 'n">WhatsApp number</label><div class="phone"><select name="dial" aria-label="Country code">' + dialOptions(ph.dial) + '</select><input id="' + pre + 'n" name="phone_local" inputmode="tel" autocomplete="off" value="' + esc(ph.num) + '" placeholder="Number without the country code"></div></div>';
  }
  function tzOffsetMs(ms, tz) {
    var f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    var o = {}; f.formatToParts(new Date(ms)).forEach(function (x) { o[x.type] = x.value; });
    return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(ms / 1000) * 1000;
  }
  /* "2026-10-12" + "21:00" read as a clock time in tz  ->  the real instant (ms) */
  function zonedToMs(dateStr, timeStr, tz) {
    var p = dateStr.split("-"), t = timeStr.split(":");
    var guess = Date.UTC(+p[0], +p[1] - 1, +p[2], +t[0], +t[1] || 0);
    var ms = guess - tzOffsetMs(guess, tz);
    return guess - tzOffsetMs(ms, tz);
  }
  function clock(ms, tz) { return new Date(ms).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).toLowerCase(); }
  function myTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Cairo"; } catch (e) { return "Africa/Cairo"; } }
  function tzLabel(tz) {
    var city = tz.split("/").pop().replace(/_/g, " "), off = "";
    try { off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date()).filter(function (x) { return x.type === "timeZoneName"; })[0].value; } catch (e) { /* no offset label */ }
    return city + (off ? " (" + off.replace("GMT", "UTC") + ")" : "");
  }
  function tzOptions(sel) {
    var list = COUNTRIES.map(function (c) { return c[2]; }).filter(function (t, i, a) { return a.indexOf(t) === i; });
    if (sel && list.indexOf(sel) < 0) list.push(sel);
    var labels = {}; list.forEach(function (t) { labels[t] = tzLabel(t); });
    list.sort(function (a, b) { return labels[a] < labels[b] ? -1 : 1; });
    return opt(list, sel, labels);
  }

  /* ------------------------------------------------------------ state */
  var sb = null, session = null, me = null;
  var S = { students: [], packages: [], payments: [], lessons: [], reports: [], notes: {}, settings: null, materials: [], academicReady: false, cur_levels: [], cur_lessons: [], cur_files: [], cur_sources: [], assignments: [] };
  var UI = { tab: "link", filter: "all", q: "", add: false, receipts: {}, draft: null, sent: "", sched: null };
  var root = null;

  /* ------------------------------------------------------------ business rules */
  function liveRate() { return (S.settings && Number(S.settings.usd_egp_rate)) || DEFAULT_RATE; }
  /* EGP price = dollar price at the saved rate, to the nearest 10 pounds */
  function egpFromUsd(usd, rate) { return Math.round(Number(usd) * (rate || liveRate()) / 10) * 10; }
  function priceFor(program, levels, offOverride) {
    var p = PRICES[program] || PRICES.general;
    var pk = PACKS.filter(function (x) { return x.levels === levels; })[0] || PACKS[0];
    var off = offOverride != null ? offOverride : pk.off;
    var usd = Math.round(p.usd * levels * (1 - off));
    return { list: p.usd * levels, off: off, usd: usd, egp: egpFromUsd(usd) };
  }
  /* what a payment is worth in dollars: dollar payments as they are, EGP payments at the rate saved with them */
  function payUsd(p) { return p.currency === "USD" ? Number(p.amount) : Number(p.amount) / (Number(p.egp_rate) || liveRate()); }
  function pkgPaidFraction(pkg, upTo) {
    return S.payments.filter(function (p) { return p.package_id === pkg.id && (!upTo || p.created_at <= upTo); }).reduce(function (a, p) {
      return a + payUsd(p) / (Number(pkg.price_usd) || 1);
    }, 0);
  }
  function pkgRemaining(pkg, cur, rate) {
    var f = Math.max(0, 1 - pkgPaidFraction(pkg));
    if (cur === "EGP") return egpFromUsd(Number(pkg.price_usd) * f, rate);
    return Math.round(Number(pkg.price_usd) * f * 100) / 100;
  }
  function pkgUsed(pkg) { return S.lessons.filter(function (l) { return l.package_id === pkg.id && USED.indexOf(l.status) >= 0; }).length; }
  function pkgIsPaid(pkg) { return pkgPaidFraction(pkg) >= 0.999; }
  /* USD payments keep the rate they were recorded at; EGP payments are already in EGP */
  function rateOf(p) { return Number(p.egp_rate) || (S.settings && Number(S.settings.usd_egp_rate)) || 0; }
  function egpOf(p) { return p.currency === "EGP" ? Number(p.amount) : Math.round(Number(p.amount) * rateOf(p)); }
  function byId(list, id) { return list.filter(function (x) { return x.id === id; })[0]; }
  function studentName(id) { var s = byId(S.students, id); return s ? s.full_name : "Unknown"; }
  function activePackage(sid) {
    var list = S.packages.filter(function (p) { return p.student_id === sid && (p.status === "active" || p.status === "pending"); });
    /* the package in use comes first (active), then the newest one waiting to start */
    return list.sort(function (a, b) { return (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || (a.created_at < b.created_at ? 1 : -1); })[0] || null;
  }
  function pkgLabel(p) { return (PRICES[p.program] || PRICES.general).name + ", " + p.levels + (p.levels === 1 ? " level" : " levels") + " (" + p.lessons_total + " lessons)"; }

  /* ------------------------------------------------------------ data */
  function loadAll() {
    var t = function (name, order) {
      var q = sb.from(name).select("*"); if (order) q = q.order(order.col, { ascending: order.asc });
      return q;
    };
    var admin = me && me.role === "admin";
    return Promise.all([
      t("students", { col: "created_at", asc: false }), t("packages", { col: "created_at", asc: false }), t("payments", { col: "created_at", asc: false }),
      t("lessons", { col: "starts_at", asc: true }), t("reports", { col: "created_at", asc: false }), t("student_notes"),
      admin ? t("settings") : Promise.resolve({ data: [], error: null }),
      t("materials", { col: "created_at", asc: false })
    ]).then(function (r) {
      S.settings = (unwrap(r[6]) || [])[0] || null;
      S.materials = unwrap(r[7]) || [];
      S.students = unwrap(r[0]) || []; S.packages = unwrap(r[1]) || []; S.payments = unwrap(r[2]) || [];
      S.lessons = unwrap(r[3]) || []; S.reports = unwrap(r[4]) || [];
      S.notes = {}; (unwrap(r[5]) || []).forEach(function (n) { S.notes[n.student_id] = n.body; });
    }).then(loadAcademic);
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
        ? '<p>We sent a sign-in code to <b>' + esc(UI.sent) + '</b>. Enter it below, or open the button in the email.</p>' +
          '<form data-form="code" class="fields" style="grid-template-columns:1fr"><div class="f"><label for="cd">Code from the email</label><input id="cd" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" maxlength="8" required></div><button class="btn" type="submit">Sign in</button></form>' +
          '<button type="button" class="linkbtn" data-act="again">Use a different email</button>'
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
      ? [["today", "Today"], ["students", "Students"], ["lessons", "Lessons"], ["academic", "Clear Academic"], ["placement", "Placement"], ["payments", "Payments"], ["account", "Account"]]
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
    if (me.role !== "admin") { root.innerHTML = shell(r.name === "receipt" && r.a ? viewReceipt(r.a) : viewMe(), "me"); return; }
    var html;
    if (r.name === "" || r.name === "today") html = shell(viewToday(), "today");
    else if (r.name === "lessons") html = shell(viewLessons(), "lessons");
    else if (r.name === "academic") html = shell(viewAcademic(r.a || "plan", r.b), "academic");
    else if (r.name === "placement" && window.CLEAR_PL) html = shell(window.CLEAR_PL.view(r), "placement");
    else if (r.name === "payments") html = shell(viewPayments(), "payments");
    else if (r.name === "account") html = shell(viewAccount(), "account");
    else if (r.name === "receipt" && r.a) html = shell(viewReceipt(r.a), "payments");
    else if (r.name === "report" && r.a) html = shell(viewReport(r.a, r.b === "edit"), "students");
    else html = shell(viewStudents(r.name === "students" ? r.a : ""), "students");
    root.innerHTML = html;
  }

  /* ------------------------------------------------------------ admin: today */
  function viewToday() {
    var now = new Date(), horizon = new Date(now.getTime() + 3 * 86400000);
    var ups = S.lessons.filter(function (l) { var d = new Date(l.starts_at); return l.status === "scheduled" && d >= new Date(now.getTime() - 3600000) && d <= horizon; }).sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; });
    var lrows = ups.map(function (l) {
      var kit = "";
      if (S.academicReady) {
        var cl = l.cur_lesson_id ? byId(S.cur_lessons, l.cur_lesson_id) : null;
        kit = cl ? '<span class="pill ' + (cl.status === "ready" ? "ok" : "warn") + '">Kit: ' + esc(cl.status) + "</span>" : '<span class="pill warn">No kit linked</span>';
      }
      return '<div class="lrow"><span class="tm">' + esc(fmtDT(l.starts_at)) + '</span><span><a href="#/students/' + l.student_id + '">' + esc(studentName(l.student_id)) + '</a><br><span class="sub">' + esc(l.topic || "No topic yet") + " · " + l.duration_min + ' min</span></span><span class="pills">' + kit + "</span></div>";
    }).join("");
    var hw = S.academicReady ? S.assignments.filter(function (a) { return a.status === "submitted"; }) : [];
    var hrows = hw.map(function (a) {
      return '<div class="lrow"><span class="tm">Homework</span><span><a href="#/students/' + a.student_id + '">' + esc(studentName(a.student_id)) + '</a><br><span class="sub">' + esc(a.title || "") + '</span></span><button type="button" class="btn sm" data-act="actab" data-v="homework">Review</button></div>';
    }).join("");
    var cps = S.academicReady ? checkpointItems().filter(function (x) { return x.due; }) : [];
    var crows = cps.map(function (x) {
      return '<div class="lrow"><span class="tm">Feedback</span><span><a href="#/students/' + x.s.id + '">' + esc(x.s.full_name) + '</a><br><span class="sub">' + esc(CHECKPOINTS[x.cp]) + '</span></span><button type="button" class="btn sm" data-act="newcp" data-id="' + x.s.id + '" data-v="' + x.cp + '">Write it</button></div>';
    }).join("");
    var unpaid = S.packages.filter(function (p) { return p.status !== "cancelled" && p.status !== "expired" && !pkgIsPaid(p); });
    var prows = unpaid.map(function (p) {
      return '<div class="lrow"><span class="tm">Payment</span><span><a href="#/students/' + p.student_id + '">' + esc(studentName(p.student_id)) + '</a><br><span class="sub">' + esc(pkgLabel(p)) + " · " + money(p.price_usd) + '</span></span><span class="pill warn">Due</span></div>';
    }).join("");
    function block(title, rows, none) { return '<div class="sec"><h3>' + title + "</h3>" + (rows ? "<div>" + rows + "</div>" : '<p class="hint">' + none + "</p>") + "</div>"; }
    return '<div class="panel" style="margin-top:18px">' +
      block("Lessons in the next 3 days", lrows, "Nothing scheduled.") +
      block("Homework waiting for your feedback", hrows, "All caught up.") +
      block("Feedback reports due", crows, "None due.") +
      block("Payments due", prows, "No unpaid packages.") + "</div>";
  }

  /* ------------------------------------------------------------ admin: students */
  function stats() {
    var now = new Date(), wk = new Date(now.getTime() + 7 * 86400000), mo = todayStr().slice(0, 7);
    var active = S.students.filter(function (s) { return s.status === "active"; }).length;
    var awaiting = S.packages.filter(function (p) { return p.status !== "cancelled" && p.status !== "expired" && !pkgIsPaid(p); }).length;
    var lw = S.lessons.filter(function (l) { var d = new Date(l.starts_at); return l.status === "scheduled" && d >= now && d <= wk; }).length;
    var usd = 0, egp = 0, all = 0;
    S.payments.forEach(function (p) { if ((p.paid_on || "").slice(0, 7) === mo) { all += egpOf(p); if (p.currency === "EGP") egp += Number(p.amount); else usd += Number(p.amount); } });
    return { active: active, awaiting: awaiting, lw: lw, usd: usd, egp: egp, all: all };
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
    var sum = '<div class="sum"><div><span class="label">Active students</span><b>' + st.active + '</b></div><div><span class="label">Payment due</span><b>' + st.awaiting + '</b></div><div><span class="label">Lessons, next 7 days</span><b>' + st.lw + '</b></div><div><span class="label">Income this month</span><b>' + money(st.usd) + (st.egp ? " + " + money(st.egp, "EGP") : "") + "</b>" + (st.usd && st.all ? "<small>about " + money(st.all, "EGP") + " in total</small>" : "") + "</div></div>";
    var addBox = UI.add ? addStudentForm() : "";
    var left = '<div class="listcol"><div class="tools"><input type="search" id="q" placeholder="Search name, email or phone" aria-label="Search students" value="' + esc(UI.q) + '">' +
      '<select id="flt" aria-label="Filter by status"><option value="all">All statuses</option>' + opt(Object.keys(STATUS), UI.filter, STATUS) + "</select>" +
      '<button type="button" class="btn sm" data-act="addtoggle">' + (UI.add ? "Close" : "Add student") + "</button></div>" + addBox + '<div class="list" id="list">' + studentRows() + "</div></div>";
    var s = id ? byId(S.students, id) : null;
    if (!s) UI.psid = null;
    var right = '<div class="panelcol">' + (s ? studentPanel(s) : '<div class="empty"><b>Select a student</b>Their profile, packages, payments, lessons and reports open here.</div>') + "</div>";
    return (s ? "" : sum) + '<div class="main' + (s ? " detail" : "") + '">' + left + right + "</div>";
  }
  function addStudentForm() {
    return '<form class="addbox" data-form="addstudent"><div class="fields">' +
      '<div class="f"><label for="an">Full name</label><input id="an" name="full_name" required></div>' +
      '<div class="f"><label for="ae">Email (their sign-in)</label><input id="ae" name="email" type="email"></div>' +
      contactFields("a", null) +
      '<div class="f"><label for="apr">Program</label><select id="apr" name="program"><option value="">Not chosen yet</option>' + opt(Object.keys(PRICES), "", mapNames()) + "</select></div>" +
      '<div class="f"><label for="ast">Status</label><select id="ast" name="status">' + opt(Object.keys(STATUS), "lead", STATUS) + "</select></div>" +
      '<div class="f wide"><label for="ag">Goal</label><textarea id="ag" name="goal"></textarea></div></div>' +
      '<div class="acts"><button class="btn" type="submit">Add student</button></div></form>';
  }
  function mapNames() { var o = {}; Object.keys(PRICES).forEach(function (k) { o[k] = PRICES[k].name; }); return o; }

  /* ---- student profile: header, key facts and tabs */
  var PTABS = [["overview", "Overview"], ["lessons", "Lessons"], ["billing", "Packages and payments"], ["files", "Materials"], ["reports", "Reports and homework"], ["notes", "Notes"], ["details", "Details"]];
  function initials(n) { var p = String(n || "").trim().split(/\s+/); return ((p[0] || "?").charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : "")).toUpperCase(); }
  function isOpen(key, dflt) { return UI.fold && UI.fold[key] != null ? UI.fold[key] : !!dflt; }
  /* a block that opens and closes, so the page shows what you need and hides the forms until you want them */
  function foldBox(key, title, body, dflt) {
    var open = isOpen(key, dflt);
    return '<div class="fold"><button type="button" class="fold-h" data-act="fold" data-v="' + key + '" aria-expanded="' + open + '"><span>' + title + '</span><i aria-hidden="true">' + (open ? "&minus;" : "+") + "</i></button>" + (open ? '<div class="fold-b">' + body + "</div>" : "") + "</div>";
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : ""; }
  function profileData(s) {
    var nowIso = new Date().toISOString();
    var d = { nowIso: nowIso };
    d.pkgs = S.packages.filter(function (p) { return p.student_id === s.id; });
    d.pays = S.payments.filter(function (p) { return p.student_id === s.id; });
    d.les = S.lessons.filter(function (l) { return l.student_id === s.id; });
    d.reps = S.reports.filter(function (r) { return r.student_id === s.id; });
    d.mats = S.materials.filter(function (m) { return m.student_id === s.id; });
    d.ap = activePackage(s.id);
    d.used = d.ap ? pkgUsed(d.ap) : 0; d.tot = d.ap ? d.ap.lessons_total : 0;
    d.upcoming = d.les.filter(function (l) { return l.status === "scheduled" && l.starts_at >= nowIso; }).sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; });
    d.toMark = d.les.filter(function (l) { return l.status === "scheduled" && l.starts_at < nowIso; }).sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; });
    d.past = d.les.filter(function (l) { return l.status !== "scheduled"; }).sort(function (a, b) { return a.starts_at < b.starts_at ? 1 : -1; });
    d.unpaid = d.pkgs.filter(function (p) { return (p.status === "pending" || p.status === "active") && !pkgIsPaid(p); });
    d.owed = d.unpaid.reduce(function (a, p) { return a + pkgRemaining(p, "USD"); }, 0);
    d.hw = S.academicReady ? S.assignments.filter(function (a) { return a.student_id === s.id; }) : [];
    d.hwReview = d.hw.filter(function (a) { return a.status === "submitted"; });
    d.cps = S.academicReady ? checkpointItems().filter(function (x) { return x.s.id === s.id && x.due; }) : [];
    return d;
  }
  function profileHeader(s, d) {
    var tz = (countryByName(s.country) || [])[2];
    var meta = [(PRICES[s.program] || {}).name || "No program yet", s.cefr ? "Level " + s.cefr : "Level not tested yet", s.country || null].filter(Boolean).map(esc).join(" &middot; ");
    var there = tz && tz !== EG ? " &middot; " + esc(clock(Date.now(), tz)) + " there now" : "";
    var wa = s.phone ? '<a class="btn sec sm" href="' + esc(waLink(s.phone)) + '" target="_blank" rel="noopener">WhatsApp</a>' : "";
    var em = s.email ? '<a class="btn sec sm" href="mailto:' + esc(s.email) + '">Email</a>' : "";
    return '<div class="phead"><div class="pav" aria-hidden="true">' + esc(initials(s.full_name)) + '</div><div class="pid"><h2>' + esc(s.full_name) + '</h2><div class="pills" style="margin-top:8px">' + statusPill(s.status) +
      (s.user_id ? '<span class="pill ok">Has signed in</span>' : '<span class="pill">Not signed in yet</span>') + '</div><p class="pmeta">' + meta + there + "</p></div>" +
      '<div class="pact noprint">' + wa + em + '<button type="button" class="btn sec sm" data-act="ptab" data-v="details">Edit details</button></div></div>';
  }
  function profileFacts(s, d) {
    var tz = (countryByName(s.country) || [])[2], nx = d.upcoming[0];
    var left = d.ap ? Math.max(0, d.tot - d.used) : 0;
    var tile = function (label, big, small, warn) { return '<div><span class="label">' + label + "</span><b" + (warn ? ' style="color:var(--warn)"' : "") + ">" + big + "</b>" + (small ? "<small>" + small + "</small>" : "") + "</div>"; };
    return '<div class="pfacts">' +
      tile("Lessons", d.ap ? d.used + " of " + d.tot + " used" : "No package yet", d.ap ? left + (left === 1 ? " lesson left" : " lessons left") : "Create one in Packages and payments") +
      tile("Next lesson", nx ? esc(fmtDT(nx.starts_at)) : "None scheduled", nx ? "Egypt time" + (tz && tz !== EG ? " &middot; " + esc(fmtDT(nx.starts_at, tz)) + " in " + esc(s.country) : "") : (d.ap ? "Build the weekly schedule in Lessons" : ""), !nx && !!d.ap) +
      tile("Payment", d.owed > 0 ? esc(money(Math.round(d.owed * 100) / 100)) + " due" : (d.pkgs.length ? "Paid" : "&mdash;"), d.owed > 0 ? esc(pkgLabel(d.unpaid[0])) : (d.ap ? esc(pkgLabel(d.ap)) : ""), d.owed > 0) +
      tile("Package valid until", d.ap && d.ap.expires_on ? esc(prettyDate(d.ap.expires_on)) : (d.ap ? "Starts at first lesson" : "&mdash;"), d.ap && d.ap.pause_until ? "Paused until " + esc(d.ap.pause_until) : (d.ap ? "10 weeks from the first lesson" : "")) + "</div>";
  }
  function profileTabs(d, cur) {
    var n = { lessons: d.upcoming.length, files: d.mats.length, reports: d.reps.length };
    var flag = { lessons: d.toMark.length > 0, billing: d.owed > 0, reports: d.hwReview.length > 0 || d.cps.length > 0 };
    return '<div class="ptabs noprint" role="group" aria-label="Student sections">' + PTABS.map(function (t) {
      var k = t[0] === "reports" ? "reports" : t[0], c = n[k];
      return '<button type="button" data-act="ptab" data-v="' + t[0] + '" aria-pressed="' + (cur === t[0]) + '">' + t[1] + (c ? ' <span class="cnt">' + c + "</span>" : "") + (flag[t[0]] ? ' <span class="dot" title="Needs attention"></span>' : "") + "</button>";
    }).join("") + "</div>";
  }
  function miniLesson(l) {
    var u = safeUrl(l.meeting_url) || safeUrl(S.settings && S.settings.default_meeting_url);
    return '<div class="mini"><span><b>' + esc(fmtDT(l.starts_at)) + '</b><br><span class="sub">' + esc(l.topic || "No topic yet") + " &middot; " + l.duration_min + ' min</span></span>' + (u ? '<a class="btn sec sm" href="' + esc(u) + '" target="_blank" rel="noopener">Open link</a>' : "") + "</div>";
  }
  function overviewTab(s, d) {
    var items = [], go = function (tab, label) { return '<button type="button" class="btn sm" data-act="ptab" data-v="' + tab + '">' + label + "</button>"; };
    if (d.toMark.length) items.push([d.toMark.length + (d.toMark.length === 1 ? " lesson has passed and still needs" : " lessons have passed and still need") + " marking", go("lessons", "Mark them")]);
    if (d.owed > 0) items.push([esc(money(Math.round(d.owed * 100) / 100)) + " is due on " + esc(pkgLabel(d.unpaid[0])), go("billing", "Record payment")]);
    if (!d.pkgs.length) items.push(["No package yet", go("billing", "Create a package")]);
    else if (d.ap && !d.upcoming.length && d.used < d.tot) items.push(["No upcoming lessons are scheduled", go("lessons", "Schedule lessons")]);
    d.cps.forEach(function (x) { items.push(["Feedback report due: " + esc(CHECKPOINTS[x.cp]), '<button type="button" class="btn sm" data-act="newcp" data-id="' + s.id + '" data-v="' + x.cp + '">Write it</button>']); });
    if (d.hwReview.length) items.push([d.hwReview.length + (d.hwReview.length === 1 ? " homework is" : " homeworks are") + " waiting for your feedback", go("reports", "Review")]);
    var todo = '<div class="sec"><h3>Needs your attention</h3>' + (items.length ? '<div class="cards">' + items.map(function (i) { return '<div class="card todo"><span>' + i[0] + "</span>" + i[1] + "</div>"; }).join("") + "</div>" : '<p class="hint">Nothing needs attention right now.</p>') + "</div>";
    var up = d.upcoming.slice(0, 3).map(miniLesson).join("");
    var rec = d.past.slice(0, 3).map(function (l) {
      var cls = l.status === "completed" ? " ok" : (l.status === "no_show" || l.status === "late_cancel") ? " warn" : "";
      return '<div class="mini"><span><b>' + esc(fmtDT(l.starts_at)) + '</b><br><span class="sub">' + esc(l.topic || "No topic recorded") + '</span></span><span class="pill' + cls + '">' + esc(LSTATUS[l.status] || l.status) + "</span></div>";
    }).join("");
    var lessonsBox = '<div class="pcols"><div class="sec"><h3>Upcoming lessons</h3>' + (up || '<p class="hint">Nothing scheduled.</p>') + (d.upcoming.length > 3 ? '<button type="button" class="linkbtn" data-act="ptab" data-v="lessons">See all ' + d.upcoming.length + " lessons</button>" : "") + "</div>" +
      '<div class="sec"><h3>Recent lessons</h3>' + (rec || '<p class="hint">No lessons delivered yet.</p>') + (d.past.length > 3 ? '<button type="button" class="linkbtn" data-act="ptab" data-v="lessons">See all</button>' : "") + "</div></div>";
    var pk = "";
    if (d.ap) {
      var paid = pkgIsPaid(d.ap), pct = Math.min(100, Math.round(d.used / (d.tot || 1) * 100));
      pk = '<div class="sec"><h3>Current package</h3><div class="card"><div class="l1"><span class="t">' + esc(pkgLabel(d.ap)) + '</span><span class="pills"><span class="pill ' + (paid ? "ok" : "warn") + '">' + (paid ? "Paid" : "Payment due") + '</span></span></div><span class="bar" aria-hidden="true"><i style="width:' + pct + '%"></i></span><span class="hint">' + d.used + " of " + d.tot + " lessons used &middot; " + money(d.ap.price_usd) + (d.ap.expires_on ? " &middot; valid until " + esc(prettyDate(d.ap.expires_on)) : "") + "</span></div></div>";
    }
    var note = (S.notes[s.id] || "").trim();
    var about = '<div class="sec"><h3>Goal and notes</h3><div class="card"><span class="label">Goal</span><p style="margin:0">' + (s.goal ? esc(s.goal) : '<span class="hint">No goal written yet.</span>') + '</p><span class="label">Your private note</span><p style="margin:0">' + (note ? esc(note.length > 240 ? note.slice(0, 240) + "…" : note) : '<span class="hint">No note yet.</span>') + '</p><div class="acts"><button type="button" class="btn sec sm" data-act="ptab" data-v="notes">Open notes</button><button type="button" class="btn sec sm" data-act="ptab" data-v="details">Edit goal</button></div></div></div>';
    return todo + lessonsBox + pk + about;
  }
  function studentPanel(s) {
    if (UI.psid !== s.id) { UI.psid = s.id; UI.ptab = "overview"; UI.fold = {}; }
    var d = profileData(s), tab = UI.ptab || "overview", body;
    if (tab === "lessons") body = lessonsSection(s, d.pkgs, d.les);
    else if (tab === "billing") body = packagesSection(s, d.pkgs, d.pays);
    else if (tab === "files") body = materialsSection(s, d.les);
    else if (tab === "reports") body = checkpointStrip(s) + reportsSection(s, d.reps) + homeworkSection(s, d);
    else if (tab === "notes") body = notesSection(s);
    else if (tab === "details") body = detailsSection(s) + dangerSection(s);
    else body = overviewTab(s, d);
    return '<div class="panel"><div class="acts noprint"><button type="button" class="btn sec sm back" data-act="back">&larr; All students</button></div>' +
      profileHeader(s, d) + profileFacts(s, d) + profileTabs(d, tab) + '<div class="ptab-body">' + body + "</div></div>";
  }
  function homeworkSection(s, d) {
    if (!S.academicReady) return "";
    var form = '<form data-form="newhw" class="addbox"><input type="hidden" name="student_id" value="' + s.id + '"><div class="fields"><div class="f"><label for="nh2">Title</label><input id="nh2" name="title" required></div><div class="f"><label for="nh3">Due date</label><input id="nh3" name="due_on" type="date"></div>' +
      '<div class="f wide"><label for="nh4">Instructions</label><textarea id="nh4" name="instructions"></textarea></div></div><div class="acts"><button class="btn" type="submit">Assign</button></div></form>';
    return '<div class="sec"><h3>Homework</h3><div class="cards">' + (d.hw.map(hwCard).join("") || '<p class="hint">No homework yet.</p>') + "</div>" + foldBox("hw", "Assign homework", form, false) + "</div>";
  }
  function detailsSection(s) {
    return '<div class="sec"><h3>Details</h3><form data-form="savestudent" data-id="' + s.id + '"><div class="fields">' +
      '<div class="f"><label for="d1">Full name</label><input id="d1" name="full_name" value="' + esc(s.full_name) + '" required></div>' +
      '<div class="f"><label for="d2">Email (their sign-in)</label><input id="d2" name="email" type="email" value="' + esc(s.email) + '"></div>' +
      contactFields("d", s) +
      '<div class="f"><label for="d5">Program</label><select id="d5" name="program"><option value="">Not chosen yet</option>' + opt(Object.keys(PRICES), s.program, mapNames()) + "</select></div>" +
      '<div class="f"><label for="d6">Level (CEFR)</label><select id="d6" name="cefr"><option value="">Not tested yet</option>' + opt(CEFR, s.cefr) + "</select></div>" +
      '<div class="f"><label for="d6b">CLEAR level (what she sees)</label><select id="d6b" name="level_code"><option value="">Not set</option>' + S.cur_levels.map(function (lv) { return '<option value="' + esc(lv.code) + '"' + (s.level_code === lv.code ? " selected" : "") + ">" + esc(lv.code + " " + lv.name) + "</option>"; }).join("") + "</select></div>" +
      '<div class="f"><label for="d7">Status</label><select id="d7" name="status">' + opt(Object.keys(STATUS), s.status, STATUS) + "</select></div>" +
      '<div class="f"><label for="d9">Payment due flag</label><select id="d9" name="payment_due"><option value="">No</option><option value="1"' + (s.payment_due ? " selected" : "") + '>Yes: show reminder at top of her account</option></select></div>' +
      '<div class="f"><label for="d10">What is due (shown to student)</label><input id="d10" name="payment_due_note" placeholder="e.g. Level A1.2" value="' + esc(s.payment_due_note || "") + '"></div>' +
      '<div class="f wide"><label for="d8">Goal</label><textarea id="d8" name="goal">' + esc(s.goal) + "</textarea></div></div>" +
      '<div class="acts" style="margin-top:12px"><button class="btn" type="submit">Save details</button>' + (s.phone ? '<a class="btn sec" href="' + esc(waLink(s.phone)) + '" target="_blank" rel="noopener">Open WhatsApp chat</a>' : "") + "</div></form></div>" + levelResultSection(s);
  }
  function levelResultSection(s) {
    if (!S.cur_levels.length) return "";
    var past = (S.level_results || []).filter(function (r) { return r.student_id === s.id; }).sort(function (a, b) { return a.decided_at < b.decided_at ? 1 : -1; });
    return '<div class="sec"><h3>Level result</h3><p class="hint">A pass moves her to the next level automatically. Needs practice keeps her where she is. The exam will write here too.</p>' +
      '<form data-form="levelresult" data-id="' + s.id + '"><div class="fields">' +
      '<div class="f"><label for="lr1">Level</label><select id="lr1" name="level_code">' + S.cur_levels.map(function (lv) { return '<option value="' + esc(lv.code) + '"' + (s.level_code === lv.code ? " selected" : "") + ">" + esc(lv.code + " " + lv.name) + "</option>"; }).join("") + "</select></div>" +
      '<div class="f"><label for="lr2">Outcome</label><select id="lr2" name="outcome"><option value="pass">Pass</option><option value="needs_practice">Needs practice</option></select></div>' +
      '<div class="f"><label for="lr3">Score % (optional)</label><input id="lr3" name="score" type="number" min="0" max="100"></div>' +
      '<div class="f wide"><label for="lr4">Note (optional)</label><input id="lr4" name="note"></div></div>' +
      '<div class="acts" style="margin-top:12px"><button class="btn" type="submit">Save result</button></div></form>' +
      (past.length ? '<div class="cards" style="margin-top:12px">' + past.map(function (r) { return '<div class="card"><div class="l1"><span class="t">' + esc(r.level_code) + '</span><span class="pill ' + (r.outcome === "pass" ? "ok" : "warn") + '">' + (r.outcome === "pass" ? "Pass" : "Needs practice") + '</span></div><span class="hint">' + esc(String(r.decided_at).slice(0, 10)) + (r.score != null ? " · " + esc(r.score) + "%" : "") + (r.note ? " · " + esc(r.note) : "") + "</span></div>"; }).join("") + "</div>" : "") + "</div>";
  }

  /* ---- packages and payments */
  function packagesSection(s, pkgs, pays) {
    var cards = pkgs.map(function (p) {
      var used = pkgUsed(p), paid = pkgIsPaid(p), pp = pays.filter(function (x) { return x.package_id === p.id; });
      var rem = pkgRemaining(p, "USD"), pct = Math.min(100, Math.round(used / (p.lessons_total || 1) * 100));
      var payForm = '<form data-form="addpay" data-id="' + p.id + '" class="addbox"><div class="fields">' +
        '<div class="f"><label for="pa' + p.id + '">Amount received</label><input id="pa' + p.id + '" name="amount" type="number" step="0.01" min="0.01" required value="' + rem + '"></div>' +
        '<div class="f"><label for="pc' + p.id + '">Currency</label><select id="pc' + p.id + '" name="currency" data-change="paycur" data-id="' + p.id + '"><option>USD</option><option>EGP</option></select></div>' +
        '<div class="f" data-rate="1"><label for="px' + p.id + '">EGP per $1 used for this payment (kept on the record)</label><input id="px' + p.id + '" name="egp_rate" type="number" step="0.0001" min="1" value="' + esc(S.settings ? S.settings.usd_egp_rate : "") + '"></div>' +
        '<div class="f"><label for="pm' + p.id + '">Method</label><select id="pm' + p.id + '" name="method">' + opt(METHODS, "InstaPay") + "</select></div>" +
        '<div class="f"><label for="pr' + p.id + '">Reference</label><input id="pr' + p.id + '" name="reference" placeholder="Transfer ID or last digits"></div>' +
        '<div class="f"><label for="pd' + p.id + '">Date received</label><input id="pd' + p.id + '" name="paid_on" type="date" value="' + todayStr() + '" required></div></div>' +
        '<p class="hint" data-eq>' + payEqText(rem, "USD", liveRate()) + '</p><div class="acts"><button class="btn" type="submit">Record payment and create receipt</button></div></form>';
      return '<div class="card pk"><div class="l1"><span class="t">' + esc(pkgLabel(p)) + '</span><span class="pills"><span class="pill ' + (paid ? "ok" : "warn") + '">' + (paid ? "Paid" : "Payment due") + '</span><span class="pill">' + esc(p.status) + "</span></span></div>" +
        '<span class="bar" aria-hidden="true"><i style="width:' + pct + '%"></i></span>' +
        '<span class="hint">' + money(p.price_usd) + (Number(p.discount_pct) ? " after " + Number(p.discount_pct) + "% discount (list " + money(p.list_price_usd) + ")" : "") + " · " + used + " of " + p.lessons_total + " lessons used" +
        (p.expires_on ? " · valid until " + esc(p.expires_on) : " · the 10 weeks start at the first lesson") + (p.pause_until ? " · paused until " + esc(p.pause_until) : "") + (paid ? "" : " · " + money(rem) + " still due") + "</span>" +
        (pp.length ? '<span class="label">Payments received</span>' : "") +
        pp.map(function (x) {
          return '<div class="card"><div class="l1"><span><b>' + money(x.amount, x.currency) + "</b>" + (x.currency === "USD" && egpOf(x) ? " <span class=\"hint\">(about " + money(egpOf(x), "EGP") + ")</span>" : "") + " · " + esc(x.method) + " · " + esc(x.paid_on) + '</span><span class="pills"><span class="pill ok">' + esc(x.receipt_no) + '</span><button type="button" class="btn sec sm" data-act="openreceipt" data-id="' + x.id + '">Open receipt</button></span></div></div>';
        }).join("") +
        (paid ? "" : foldBox("pay" + p.id, "Record a payment", payForm, true)) +
        '<div class="acts"><button type="button" class="btn danger sm" data-act="delpkg" data-id="' + p.id + '">Delete package</button></div></div>';
    }).join("");
    var prog = s.program || "general";
    var newForm = '<form data-form="addpkg" data-id="' + s.id + '" class="addbox"><div class="fields">' +
      '<div class="f"><label for="kp">Program</label><select id="kp" name="program" data-change="pkgprev">' + opt(Object.keys(PRICES), prog, mapNames()) + "</select></div>" +
      '<div class="f"><label for="kl">Levels</label><select id="kl" name="levels" data-change="pkgprev"><option value="1">1 level (8 lessons)</option><option value="2">2 levels (16 lessons), 8% off</option><option value="3">3 levels (24 lessons), 12% off</option></select></div></div>' +
      '<p class="hint" id="pkgprev">' + pkgPreview(prog, 1) + '</p><div class="acts"><button class="btn sec" type="submit">Create package</button></div></form>';
    return '<div class="sec"><h3>Packages and payments</h3><div class="cards">' + (cards || '<p class="hint">No package yet. Create one when the student chooses a program.</p>') + "</div>" +
      foldBox("newpkg", "New package", newForm, !pkgs.length) + "</div>";
  }
  function pkgPreview(prog, levels) {
    var p = priceFor(prog, levels);
    return "Price: <b>" + money(p.usd) + "</b> (about EGP " + p.egp.toLocaleString("en-US") + " today)" + (p.off ? ", list " + money(p.list) : "");
  }
  function receiptText(pay, s, pkg) {
    return ["CLEAR English Academy", "Payment receipt", "",
      "Receipt no: " + pay.receipt_no, "Date: " + pay.paid_on, "Student: " + s.full_name,
      "Program: " + (pkg ? pkgLabel(pkg) : "-"), "Amount paid: " + money(pay.amount, pay.currency),
      "Method: " + pay.method + (pay.reference ? " (" + pay.reference + ")" : ""), "Issued by: " + ISSUER, "",
      "Terms: " + TERMS].join("\n");
  }


  /* ---- designed receipt: on screen, as PDF (print) and as an image */
  function payContext(id) {
    var p = byId(S.payments, id); if (!p) return null;
    return { p: p, s: byId(S.students, p.student_id), pkg: byId(S.packages, p.package_id) };
  }
  function prettyDate(d) { try { return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); } catch (e) { return d; } }
  function balanceNote(p, pkg) {
    if (!pkg) return "";
    var f = pkgPaidFraction(pkg, p.created_at);
    if (f >= 0.999) return "Paid in full";
    var leftUsd = (1 - f) * Number(pkg.price_usd);
    var left = p.currency === "EGP" ? leftUsd * (Number(p.egp_rate) || liveRate()) : leftUsd;
    return "Balance remaining " + money(Math.round(left * 100) / 100, p.currency);
  }
  function receiptRows(c) {
    var rows = [["Received from", c.s ? c.s.full_name : "Student"], ["Program", c.pkg ? pkgLabel(c.pkg) : "-"], ["Date", prettyDate(c.p.paid_on)],
      ["Method", c.p.method + (c.p.reference ? " · " + c.p.reference : "")]];
    var bn = balanceNote(c.p, c.pkg); if (bn) rows.push(["Package", bn]);
    return rows;
  }
  function receiptEquiv(p) {
    if (p.currency !== "USD" || !egpOf(p)) return "";
    var r = rateOf(p);
    return "About " + money(egpOf(p), "EGP") + (r ? " at EGP " + (Math.round(r * 100) / 100) + " per $1" : "");
  }
  function receiptCard(c) {
    var p = c.p;
    return '<article class="report rcpt"><div class="rtop">' + logo() + '<span class="label">Payment receipt</span></div>' +
      '<div class="rhead"><div><span class="label">Receipt number</span><h2>' + esc(p.receipt_no) + '</h2></div><span class="pill ok">Payment received</span></div>' +
      "<dl>" + receiptRows(c).map(function (r) { return "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>"; }).join("") + "</dl>" +
      '<div class="amt"><span class="label">Amount received</span><b>' + esc(money(p.amount, p.currency)) + "</b>" + (receiptEquiv(p) ? "<small>" + esc(receiptEquiv(p)) + "</small>" : "") + "</div>" +
      '<p class="rfoot">Issued by ' + esc(ISSUER) + ".<br>WhatsApp +20 112 022 3509 · " + esc(CONTACT_EMAIL) + '</p><p class="terms">' + esc(TERMS) + "</p></article>";
  }
  function viewReceipt(id) {
    var c = payContext(id), admin = me.role === "admin";
    if (!c || !c.s) return '<div class="empty" style="margin-top:20px"><b>Receipt not found</b><button type="button" class="btn sec sm" data-act="go" data-v="' + (admin ? "payments" : "me") + '">Back</button></div>';
    var bar = '<div class="acts noprint" style="margin:18px 0"><button type="button" class="btn sec sm" data-act="' + (admin ? "open" : "go") + '" data-id="' + c.s.id + '" data-v="me">' + (admin ? "Back to " + esc(c.s.full_name) : "Back") + "</button>" +
      '<button type="button" class="btn sm" data-act="print">Save as PDF</button><button type="button" class="btn sm" data-act="dlpng" data-id="' + id + '">Download image</button><button type="button" class="btn sec sm" data-act="copyr" data-id="' + id + '">Copy as text</button></div>' +
      '<p class="hint noprint" style="margin:-6px 0 14px">Save as PDF opens the print window. Choose "Save as PDF" as the printer. The image is ready to send on WhatsApp.</p>';
    return bar + receiptCard(c);
  }
  function wrapText(x, text, maxW) {
    var words = String(text).split(/\s+/), lines = [], line = "";
    words.forEach(function (w) {
      var t = line ? line + " " + w : w;
      if (x.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    return lines;
  }
  function receiptPNG(c) {
    var svg = logo().replace(/var\(--ink-soft\)/g, "#5B6577").replace(/var\(--ink\)/g, "#16181D").replace("<svg ", '<svg width="618" height="156" ');
    var img = new Image();
    var loaded = new Promise(function (ok) { img.onload = ok; img.onerror = ok; });
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    var fonts = (document.fonts && document.fonts.load) ? Promise.all([document.fonts.load("600 40px Montserrat"), document.fonts.load("400 24px 'Source Sans 3'"), document.fonts.load("600 24px 'Source Sans 3'")]).catch(function () { }) : Promise.resolve();
    return Promise.all([loaded, fonts]).then(function () {
      var W = 1080, P = 72, p = c.p, INK = "#16181D", SOFT = "#5B6577", LINE = "#D9DCE2", BRAND = "#E63946";
      var cv = document.createElement("canvas"); cv.width = W; cv.height = 2400;
      var x = cv.getContext("2d"), y = 0, D = "Montserrat, 'Segoe UI', sans-serif", T = "'Source Sans 3', 'Segoe UI', sans-serif";
      x.fillStyle = "#fff"; x.fillRect(0, 0, W, 2400);
      x.fillStyle = BRAND; x.fillRect(0, 0, W, 14);
      if (img.width) x.drawImage(img, P, 70, 330, 83);
      x.fillStyle = SOFT; x.textBaseline = "alphabetic"; x.textAlign = "right"; x.font = "600 22px " + D;
      if ("letterSpacing" in x) x.letterSpacing = "3px";
      x.fillText("PAYMENT RECEIPT", W - P, 120);
      if ("letterSpacing" in x) x.letterSpacing = "0px";
      x.textAlign = "left";
      x.fillStyle = BRAND; x.fillRect(P, 190, W - 2 * P, 5);
      y = 270; x.fillStyle = SOFT; x.font = "600 20px " + D; if ("letterSpacing" in x) x.letterSpacing = "3px"; x.fillText("RECEIPT NUMBER", P, y);
      if ("letterSpacing" in x) x.letterSpacing = "0px";
      y += 62; x.fillStyle = INK; x.font = "600 58px " + D; x.fillText(p.receipt_no, P, y);
      /* paid pill */
      var pill = "PAYMENT RECEIVED"; x.font = "600 20px " + D;
      var pw = x.measureText(pill).width + 44; x.strokeStyle = "#1B7F5F"; x.lineWidth = 3;
      x.beginPath(); if (x.roundRect) x.roundRect(W - P - pw, y - 44, pw, 50, 25); else x.rect(W - P - pw, y - 44, pw, 50); x.stroke();
      x.fillStyle = "#1B7F5F"; x.fillText(pill, W - P - pw + 22, y - 12);
      y += 50;
      receiptRows(c).forEach(function (r) {
        x.fillStyle = LINE; x.fillRect(P, y, W - 2 * P, 2); y += 46;
        x.fillStyle = SOFT; x.font = "600 22px " + T; x.fillText(r[0], P, y);
        x.fillStyle = INK; x.font = "600 28px " + T;
        wrapText(x, r[1], W - 2 * P - 250).forEach(function (ln, i) { x.fillText(ln, P + 250, y + i * 36); y += i ? 36 : 0; });
        y += 26;
      });
      x.fillStyle = LINE; x.fillRect(P, y, W - 2 * P, 2); y += 40;
      /* amount block */
      var eq = receiptEquiv(p), bh = eq ? 230 : 190;
      x.fillStyle = INK; if (x.roundRect) { x.beginPath(); x.roundRect(P, y, W - 2 * P, bh, 22); x.fill(); } else x.fillRect(P, y, W - 2 * P, bh);
      x.fillStyle = "#9AA5B8"; x.font = "600 20px " + D; if ("letterSpacing" in x) x.letterSpacing = "3px"; x.fillText("AMOUNT RECEIVED", P + 40, y + 56);
      if ("letterSpacing" in x) x.letterSpacing = "0px";
      x.fillStyle = "#fff"; x.font = "600 76px " + D; x.fillText(money(p.amount, p.currency), P + 40, y + 140);
      if (eq) { x.fillStyle = "#9AA5B8"; x.font = "400 26px " + T; x.fillText(eq, P + 40, y + 190); }
      y += bh + 56;
      x.fillStyle = SOFT; x.font = "400 24px " + T;
      ["Issued by " + ISSUER + ".", "WhatsApp +20 112 022 3509 · " + CONTACT_EMAIL].forEach(function (ln) { x.fillText(ln, P, y); y += 34; });
      y += 14; x.font = "400 19px " + T;
      wrapText(x, TERMS, W - 2 * P).forEach(function (ln) { x.fillText(ln, P, y); y += 27; });
      y += 50;
      var out = document.createElement("canvas"); out.width = W; out.height = y;
      out.getContext("2d").drawImage(cv, 0, 0);
      return new Promise(function (ok) { out.toBlob(ok, "image/png"); });
    });
  }

  /* ---- weekly schedule: pick the days once, the lessons are built from it */
  var COUNTED = ["scheduled", "completed", "late_cancel", "no_show"];
  function initSched(s, pkg) {
    var has = pkg.schedule && pkg.schedule.length;
    return {
      sid: s.id, pkgId: pkg.id,
      rows: has ? pkg.schedule.map(function (r) { return { dow: Number(r.dow), time: r.time, min: Number(r.min) || progMins(pkg.program) }; }) : [{ dow: 1, time: "21:00", min: progMins(pkg.program) }, { dow: 4, time: "21:00", min: progMins(pkg.program) }],
      tz: EG, start: addDays(todayStr(), 1)
    };
  }
  function schedFor(s) {
    var pkgs = S.packages.filter(function (p) { return p.student_id === s.id && (p.status === "pending" || p.status === "active"); });
    if (!pkgs.length) return null;
    var st = UI.sched;
    if (!st || st.sid !== s.id || !byId(pkgs, st.pkgId)) st = UI.sched = initSched(s, pkgs.filter(pkgIsPaid)[0] || pkgs[0]);
    return { st: st, pkgs: pkgs };
  }
  function readSched(form) {
    var f = new FormData(form), rows = [], i = 0;
    while (f.has("dow_" + i)) { rows.push({ dow: parseInt(f.get("dow_" + i), 10), time: String(f.get("time_" + i) || ""), min: parseInt(f.get("min_" + i), 10) || 60 }); i++; }
    return { sid: form.getAttribute("data-id"), pkgId: f.get("pkg") || (UI.sched && UI.sched.pkgId), rows: rows, tz: EG, start: f.get("start") || todayStr() };
  }
  function schedCounts(pkg) {
    var now = new Date(), mine = S.lessons.filter(function (l) { return l.package_id === pkg.id; });
    var have = mine.filter(function (l) { return COUNTED.indexOf(l.status) >= 0; }).length;
    var upcoming = mine.filter(function (l) { return l.status === "scheduled" && new Date(l.starts_at) >= now; }).length;
    return { have: have, upcoming: upcoming };
  }
  function schedDates(rows, start, n) {
    var out = [], d = start, k, sorted = rows.filter(function (r) { return r.time && r.dow >= 0 && r.dow <= 6; }).sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
    for (k = 0; k < 366 && out.length < n && sorted.length; k++, d = addDays(d, 1)) {
      var dow = new Date(d + "T00:00:00Z").getUTCDay();
      sorted.forEach(function (r) { if (out.length < n && r.dow === dow) out.push({ date: d, time: r.time, min: r.min }); });
    }
    return out;
  }
  function schedPreview(st) {
    var pkg = byId(S.packages, st.pkgId); if (!pkg) return "";
    var c = schedCounts(pkg), n = pkg.lessons_total - c.have + c.upcoming;
    if (!st.rows.length) return '<p class="hint">Add at least one day.</p>';
    if (n <= 0) return '<p class="hint">All ' + pkg.lessons_total + " lessons of this package are already delivered.</p>";
    var list = schedDates(st.rows, st.start, n);
    if (!list.length) return '<p class="hint">Fill in the day and start time of each row.</p>';
    var items = list.map(function (l, i) {
      var ms = zonedToMs(l.date, l.time, EG), end = ms + l.min * 60000, a = clock(ms, EG);
      var day = new Date(l.date + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      return "<li>" + esc(day) + " · " + esc(a) + "–" + esc(clock(end, EG)) + "</li>";
    }).join("");
    var firstD = list[0].date, lastD = list[list.length - 1].date, lim = addDays(firstD, 70);
    return "<p><b>" + list.length + " lessons</b> (Egypt time), from " + esc(firstD) + " to " + esc(lastD) + ". The 10 weeks end on " + esc(lim) + ".</p>" +
      (lastD > lim ? '<p class="err">The last lesson falls after the 10-week limit. Add another day per week or start earlier.</p>' : "") +
      (c.upcoming ? '<p class="hint">This replaces the ' + c.upcoming + " upcoming lessons already scheduled.</p>" : "") +
      '<ol class="prev">' + items + "</ol>";
  }
  function scheduleSection(s) {
    var info = schedFor(s);
    if (!info) return '<p class="hint">Create a package first (Packages and payments). Then pick the weekly days here and the lessons are built for you.</p>';
    var st = info.st;
    var rows = st.rows.map(function (r, i) {
      return '<div class="srow"><div class="f"><label for="sd' + i + '">Day</label><select id="sd' + i + '" name="dow_' + i + '">' + DOWS.map(function (d) { return '<option value="' + d[0] + '"' + (d[0] === r.dow ? " selected" : "") + ">" + d[1] + "</option>"; }).join("") + "</select></div>" +
        '<div class="f"><label for="st' + i + '">Starts</label><input id="st' + i + '" name="time_' + i + '" type="time" value="' + esc(r.time) + '" required></div>' +
        '<div class="f"><label for="sm' + i + '">Minutes</label><input id="sm' + i + '" name="min_' + i + '" type="number" min="15" max="180" step="5" value="' + r.min + '" required></div>' +
        '<button type="button" class="btn danger sm" data-act="delday" data-i="' + i + '" aria-label="Remove this day">Remove</button></div>';
    }).join("");
    var pkgSel = info.pkgs.length > 1 ? '<div class="f"><label for="spk">Package</label><select id="spk" name="pkg" data-change="schedpkg" data-id="' + s.id + '">' + info.pkgs.map(function (p) { return '<option value="' + p.id + '"' + (p.id === st.pkgId ? " selected" : "") + ">" + esc(pkgLabel(p)) + (pkgIsPaid(p) ? " · paid" : " · payment due") + "</option>"; }).join("") + "</select></div>" : "";
    return '<form data-form="schedule" data-id="' + s.id + '" class="addbox">' + pkgSel +
      '<div class="srows">' + rows + '</div><div class="acts"><button type="button" class="btn sec sm" data-act="addday">Add another day</button></div>' +
      '<div class="fields"><div class="f"><label for="sst">First lesson on or after</label><input id="sst" name="start" type="date" value="' + esc(st.start) + '" required></div></div>' +
      '<p class="hint">All times are Egypt time. Students see them in Egypt time and can convert them to their own.</p>' +
      '<div id="schedprev" aria-live="polite">' + schedPreview(st) + '</div><div class="acts"><button class="btn" type="submit">Create the lessons</button></div></form>';
  }
  function submitSchedule(form, done) {
    var st = UI.sched = readSched(form), pkg = byId(S.packages, st.pkgId);
    if (!pkg) { toast("Choose a package.", true); return done(); }
    var seen = {}, bad = !st.rows.length;
    st.rows.forEach(function (r) { var k = r.dow + "@" + r.time; if (!r.time || !(r.dow >= 0 && r.dow <= 6) || seen[k]) bad = true; seen[k] = 1; });
    if (bad) { toast("Check the days: each needs a day and a start time, and none can repeat.", true); return done(); }
    var c = schedCounts(pkg), n = pkg.lessons_total - c.have + c.upcoming;
    if (n <= 0) { toast("All lessons of this package are already delivered.", true); return done(); }
    var rows = st.rows.map(function (r) { return { dow: r.dow, time: r.time, min: r.min }; });
    var go = function (replace) {
      return act(sb.from("packages").update({ schedule: rows, schedule_tz: EG }).eq("id", pkg.id), null).then(function () {
        return act(sb.rpc("generate_lessons", { p_package: pkg.id, p_start: st.start, p_replace: replace }), null);
      }).then(function (made) { toast(made + " lessons scheduled."); if (UI.fold) delete UI.fold.sched; return refresh(); });
    };
    (c.upcoming ? ask("This package already has " + c.upcoming + " upcoming lessons. Replace them with this schedule?", "Replace them") : Promise.resolve(true)).then(function (ok) {
      return ok ? go(c.upcoming > 0) : null;
    }).then(done, done);
  }

  /* ---- lessons */
  function lessonRow(l, nowIso) {
    var open = isOpen("l" + l.id, false), passed = l.status === "scheduled" && l.starts_at < nowIso;
    var cls = l.status === "completed" ? " ok" : (l.status === "no_show" || l.status === "late_cancel") ? " warn" : "";
    var nf = S.materials.filter(function (m) { return m.lesson_id === l.id; }).length;
    var cl = S.academicReady && l.cur_lesson_id ? byId(S.cur_lessons, l.cur_lesson_id) : null;
    var plan = S.academicReady ? '<div class="f lr-plan"><label for="lc' + l.id + '">Lesson in the plan (fills the topic)</label><select id="lc' + l.id + '" data-change="lcur" data-id="' + l.id + '">' + curOptions(l.cur_lesson_id) + "</select></div>" : "";
    var head = '<div class="lr-h"><button type="button" class="lr-t" data-act="fold" data-v="l' + l.id + '" aria-expanded="' + open + '"><b>' + esc(fmtDT(l.starts_at)) + '</b><span class="sub">' + esc(l.topic || (cl ? cl.title : "No topic yet")) + " · " + l.duration_min + " min &middot; " + (open ? "close" : "edit") + '</span></button><span class="pills">' +
      (passed ? '<span class="pill warn">Needs marking</span>' : '<span class="pill' + cls + '">' + esc(LSTATUS[l.status] || l.status) + "</span>") + (nf ? '<span class="pill">' + nf + (nf === 1 ? " file" : " files") + "</span>" : "") + "</span></div>";
    var mark = passed ? '<div class="acts"><button type="button" class="btn sm" data-act="lmark" data-id="' + l.id + '" data-v="completed">Mark completed</button><button type="button" class="btn sec sm" data-act="lmark" data-id="' + l.id + '" data-v="no_show">No-show</button><button type="button" class="btn sec sm" data-act="lmark" data-id="' + l.id + '" data-v="moved">Moved</button></div>' : "";
    var body = open ? '<div class="lr-b"><div class="f" style="max-width:260px"><label for="ls_' + l.id + '">Status</label><select id="ls_' + l.id + '" data-change="lstatus" data-id="' + l.id + '">' + opt(Object.keys(LSTATUS), l.status, LSTATUS) + "</select></div>" + lessonFiles(l) +
      '<form data-form="savelesson" data-id="' + l.id + '"><div class="fields"><div class="f"><label for="lt' + l.id + '">Topic</label><input id="lt' + l.id + '" name="topic" value="' + esc(l.topic) + '"></div>' +
      '<div class="f"><label for="lm' + l.id + '">Meeting link</label><input id="lm' + l.id + '" name="meeting_url" type="url" value="' + esc(l.meeting_url) + '"></div>' +
      '<div class="f wide"><label for="lsu' + l.id + '">Note the student will see</label><textarea id="lsu' + l.id + '" name="summary">' + esc(l.summary) + "</textarea></div></div>" +
      '<div class="acts" style="margin-top:8px"><button class="btn sec sm" type="submit">Save</button><button type="button" class="btn danger sm" data-act="dellesson" data-id="' + l.id + '">Delete lesson</button></div></form></div>' : "";
    return '<div class="lr' + (passed ? " due" : "") + '">' + head + plan + mark + body + "</div>";
  }
  function lessonsSection(s, pkgs, les) {
    var d = profileData(s), nowIso = d.nowIso;
    var group = function (title, list, none) { return '<div class="sec"><h3>' + title + (list.length ? " (" + list.length + ")" : "") + '</h3><div class="cards">' + (list.map(function (l) { return lessonRow(l, nowIso); }).join("") || '<p class="hint">' + none + "</p>") + "</div></div>"; };
    var allPast = isOpen("allpast", false), pastShown = allPast ? d.past : d.past.slice(0, 6);
    var pastBlock = '<div class="sec"><h3>Past lessons' + (d.past.length ? " (" + d.past.length + ")" : "") + '</h3><div class="cards">' + (pastShown.map(function (l) { return lessonRow(l, nowIso); }).join("") || '<p class="hint">No lessons delivered yet.</p>') + "</div>" +
      (d.past.length > 6 ? '<button type="button" class="linkbtn" data-act="fold" data-v="allpast" aria-expanded="' + allPast + '">' + (allPast ? "Show fewer" : "Show all " + d.past.length) + "</button>" : "") + "</div>";
    var start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 24);
    var opts = '<option value="">No package</option>' + pkgs.map(function (p) { return '<option value="' + p.id + '">' + esc(pkgLabel(p)) + "</option>"; }).join("");
    var ap = activePackage(s.id);
    var addForm = '<form data-form="addlesson" data-id="' + s.id + '" class="addbox"><div class="fields">' +
      '<div class="f"><label for="lw">Date and time</label><input id="lw" name="when" type="datetime-local" required value="' + localInputValue(start) + '"></div>' +
      '<div class="f"><label for="ld">Minutes</label><input id="ld" name="duration" type="number" min="15" max="180" step="5" value="' + progMins(ap ? ap.program : s.program) + '" required></div>' +
      '<div class="f"><label for="lp">Package</label><select id="lp" name="package_id">' + opts.replace('value="' + (ap ? ap.id : "") + '"', 'value="' + (ap ? ap.id : "") + '" selected') + "</select></div>" +
      '<div class="f"><label for="lto">Topic</label><input id="lto" name="topic"></div></div>' +
      '<p class="hint">Egypt time. Students can switch the lessons to their own time zone.</p><div class="acts"><button class="btn sec" type="submit">Schedule lesson</button></div></form>';
    return (d.toMark.length ? group("Needs marking", d.toMark, "") : "") + group("Upcoming lessons", d.upcoming, "Nothing scheduled yet.") + pastBlock +
      '<div class="sec"><h3>Plan more lessons</h3><div class="cards">' + foldBox("sched", "Weekly schedule: build the lessons from fixed days", scheduleSection(s), !d.les.length) +
      foldBox("addles", "Add a single lesson (a make-up or an extra)", addForm, false) + "</div></div>";
  }

  /* ---- materials: files from your device, opened by the student */
  function fmtSize(n) { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function lessonLabel(id) { var l = byId(S.lessons, id); return l ? fmtDT(l.starts_at) : ""; }
  function lessonFiles(l) {
    var list = S.materials.filter(function (m) { return m.lesson_id === l.id; });
    if (!list.length) return "";
    return '<div class="files">' + list.map(function (m) { return '<button type="button" class="linkbtn" data-act="openfile" data-id="' + m.id + '">&#128206; ' + esc(m.title) + "</button>"; }).join("") + "</div>";
  }
  function materialRow(m, admin) {
    var ll = m.lesson_id ? lessonLabel(m.lesson_id) : "";
    return '<div class="card"><div class="l1"><span class="t">' + esc(m.title) + '</span><span class="pills"><span class="pill">' + esc(MKINDS[m.kind] || m.kind) + "</span></span></div>" +
      '<span class="hint">' + esc(m.file_name) + " · " + esc(fmtSize(m.size_bytes)) + (ll ? " · lesson " + esc(ll) : "") + " · added " + esc((m.created_at || "").slice(0, 10)) + "</span>" +
      (m.note ? "<p>" + esc(m.note) + "</p>" : "") +
      '<div class="acts"><button type="button" class="btn sm" data-act="openfile" data-id="' + m.id + '">Open or download</button>' +
      (admin ? '<button type="button" class="btn danger sm" data-act="delmat" data-id="' + m.id + '">Delete</button>' : "") + "</div></div>";
  }
  function materialsSection(s, les) {
    var mine = S.materials.filter(function (m) { return m.student_id === s.id; });
    var now = new Date().toISOString();
    var up = les.filter(function (l) { return l.status === "scheduled" && l.starts_at >= now; }).sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; });
    var past = les.filter(function (l) { return !(l.status === "scheduled" && l.starts_at >= now); }).sort(function (a, b) { return a.starts_at < b.starts_at ? 1 : -1; });
    var lopts = '<option value="">Not tied to one lesson</option>' + up.concat(past).map(function (l, i) {
      return '<option value="' + l.id + '"' + (i === 0 && up.length ? " selected" : "") + ">" + esc(fmtDT(l.starts_at)) + "</option>";
    }).join("");
    var upForm = '<form data-form="addmaterial" data-id="' + s.id + '" class="addbox"><div class="fields">' +
      '<div class="f wide"><label for="mf">File from your device</label><input id="mf" name="file" type="file" accept="' + FILE_ACCEPT + '" required><span class="hint">PowerPoint, PDF, Word, Excel, images, audio or short video. Up to 50 MB.</span></div>' +
      '<div class="f"><label for="mt">Title (optional)</label><input id="mt" name="title" placeholder="Uses the file name"></div>' +
      '<div class="f"><label for="mk">Type</label><select id="mk" name="kind">' + opt(Object.keys(MKINDS), "slides", MKINDS) + "</select></div>" +
      '<div class="f"><label for="ml">For which lesson</label><select id="ml" name="lesson_id">' + lopts + "</select></div>" +
      '<div class="f wide"><label for="mn">Note the student will see (optional)</label><textarea id="mn" name="note"></textarea></div></div>' +
      '<div class="acts"><button class="btn" type="submit">Upload file</button></div></form>';
    return '<div class="sec"><h3>Materials</h3><div class="cards">' + (mine.map(function (m) { return materialRow(m, true); }).join("") || '<p class="hint">No files yet. Upload slides or a handout and the student can open them from their page.</p>') + "</div>" + foldBox("upload", "Upload a file", upForm, !mine.length) + "</div>";
  }
  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10); }
  function uploadMaterial(sid, d, done) {
    var file = d.file;
    if (!file || !file.size) { toast("Choose a file from your device first.", true); return done(); }
    var ext = (file.name.split(".").pop() || "").toLowerCase(), mime = EXT_MIME[ext];
    if (!mime) { toast("That file type is not supported. Use PowerPoint, PDF, Word, Excel, an image, audio or mp4.", true); return done(); }
    if (file.size > MAX_FILE) { toast("That file is over 50 MB. Compress it or share a link instead.", true); return done(); }
    var path = sid + "/" + uid() + "-" + file.name.replace(/[^\w.\-]+/g, "-");
    toast("Uploading " + file.name + "…");
    var bucket = sb.storage.from("materials");
    bucket.upload(path, file, { contentType: mime, upsert: false }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return sb.from("materials").insert({ student_id: sid, lesson_id: nul(d.lesson_id), title: d.title || file.name.replace(/\.[^.]+$/, ""), kind: d.kind, note: nul(d.note), file_path: path, file_name: file.name, mime: mime, size_bytes: file.size });
    }).then(function (r) {
      if (r.error) { bucket.remove([path]); throw new Error(r.error.message); }
      toast("File uploaded."); return refresh();
    }).catch(function (e) { toast(e.message || "Upload failed.", true); }).then(done, done);
  }
  function openMaterial(id) {
    var m = byId(S.materials, id); if (!m) return;
    var inline = /^(application\/pdf|image\/|audio\/|video\/)/.test(m.mime || "");
    var w = window.open("", "_blank");
    sb.storage.from("materials").createSignedUrl(m.file_path, 300, inline ? undefined : { download: m.file_name }).then(function (r) {
      if (r.error || !r.data) { if (w) w.close(); return toast("Could not open that file. Try again.", true); }
      if (w) { try { w.opener = null; } catch (e) { /* ignore */ } w.location.href = r.data.signedUrl; } else location.href = r.data.signedUrl;
    }, function () { if (w) w.close(); toast("Could not open that file. Try again.", true); });
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
    return '<div class="sec"><h3>Danger zone</h3><p class="hint">Deleting removes the student with every package, payment, lesson and report. This cannot be undone.</p><div class="acts"><button type="button" class="btn danger sm" data-act="delstudent" data-id="' + s.id + '">Delete this student and all their records</button></div></div>';
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

  /* ------------------------------------------------------------ admin: price list, discount and price message */
  function hasPriceCols() { return !!(S.settings && Object.prototype.hasOwnProperty.call(S.settings, "instapay")); }
  function n0(x) { return Number(x).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
  function roundRate(r) { return Math.round(Number(r) * 100) / 100; }
  function fmtStamp(iso) {
    try { return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: EG }) + " Egypt time"; } catch (e) { return ""; }
  }
  /* the dollar figure shown beside a recorded payment: its own rate, or today's rate if you switch the ledger */
  function egpView(p) { return UI.payToday && p.currency === "USD" ? Math.round(Number(p.amount) * liveRate()) : egpOf(p); }

  /* ---- latest USD to EGP rate */
  function fetchJSON(url, ms) {
    var ctl = window.AbortController ? new AbortController() : null, timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 8000);
    return fetch(url, ctl ? { signal: ctl.signal, cache: "no-store" } : { cache: "no-store" }).then(function (r) {
      clearTimeout(timer); if (!r.ok) throw new Error("HTTP " + r.status); return r.json();
    }, function (e) { clearTimeout(timer); throw e; });
  }
  function fetchLatestRate() {
    var i = 0;
    function next() {
      if (i >= RATE_SOURCES.length) return Promise.reject(new Error("Could not reach an exchange-rate service. Check your connection, or type the rate by hand and save."));
      var s = RATE_SOURCES[i++];
      return fetchJSON(s.url).then(function (j) {
        var r = Number(s.pick(j));
        if (!(r > 10 && r < 500)) throw new Error("unusable rate");
        return { rate: Math.round(r * 10000) / 10000, source: s.name };
      }).then(null, next);
    }
    return next();
  }
  function updateRateNow(btn) {
    var old = liveRate();
    if (btn) { btn.disabled = true; btn.textContent = "Checking the rate…"; }
    return fetchLatestRate().then(function (r) {
      if (Math.abs(r.rate - old) < 0.00005) { toast("Your saved rate is already EGP " + roundRate(r.rate) + " per $1 (" + r.source + ")."); return; }
      var g = PRICES.general.usd;
      return ask("The latest market rate is EGP " + roundRate(r.rate) + " per $1 (" + r.source + "). Your saved rate is EGP " + roundRate(old) + ". EGP prices will change with it, for example General English $" + g + " goes from EGP " + n0(egpFromUsd(g, old)) + " to EGP " + n0(egpFromUsd(g, r.rate)) + ". Use the new rate?", "Use this rate").then(function (ok) {
        if (!ok) { toast("Rate left as it was."); return; }
        return saveRate(r, old);
      });
    }).then(null, function (e) { toast(e.message || "Could not update the rate.", true); }).then(refresh);
  }
  function saveRate(r, old) {
    var upd = { usd_egp_rate: r.rate };
    if (hasPriceCols()) { upd.rate_updated_at = new Date().toISOString(); upd.rate_source = r.source; }
    return act(sb.from("settings").update(upd).eq("id", 1).select("id"), null).then(function (rows) {
      if (!rows || !rows.length) throw new Error("Nothing was saved. Refresh the page and sign in again.");
      toast("Rate updated: EGP " + roundRate(old) + " to EGP " + roundRate(r.rate) + " per $1 (" + r.source + ").");
    });
  }

  /* ---- discount and message options (a discount is never on after a reload, so one is not sent by mistake) */
  var PM_KEY = "clear-pricemsg";
  function pmState() {
    if (UI.pm) return;
    UI.pm = { program: "general", lang: "en", cur: "both", insta: true, terms: true, packs: true };
    UI.disc = { on: false, type: "pct", value: 10, label: "", until: "", levels: { 1: true, 2: true, 3: true } };
    var saved = null; try { saved = JSON.parse(localStorage.getItem(PM_KEY) || "null"); } catch (e) { saved = null; }
    if (saved && saved.pm) Object.keys(UI.pm).forEach(function (k) { if (saved.pm[k] != null) UI.pm[k] = saved.pm[k]; });
    if (saved && saved.disc) {
      ["type", "value", "label", "until"].forEach(function (k) { if (saved.disc[k] != null) UI.disc[k] = saved.disc[k]; });
      if (saved.disc.levels) [1, 2, 3].forEach(function (l) { if (saved.disc.levels[l] != null) UI.disc.levels[l] = !!saved.disc.levels[l]; });
    }
    if (UI.pm.program !== "all" && !PRICES[UI.pm.program]) UI.pm.program = "general";
  }
  function savePM() { try { localStorage.setItem(PM_KEY, JSON.stringify({ pm: UI.pm, disc: UI.disc })); } catch (e) { /* storage blocked */ } }
  function discOn() { return !!(UI.disc && UI.disc.on && Number(UI.disc.value) > 0); }
  /* one package (dollars): price after the package discount, then after your own discount if it is switched on for that package */
  function offerFor(program, levels) {
    var p = PRICES[program] || PRICES.general;
    var pk = PACKS.filter(function (x) { return x.levels === levels; })[0] || PACKS[0];
    var list = p.usd * levels, base = Math.round(list * (1 - pk.off)), fin = base;
    if (discOn() && UI.disc.levels[levels]) {
      var v = Number(UI.disc.value);
      fin = UI.disc.type === "pct" ? Math.round(base * (1 - Math.min(100, v) / 100)) : Math.max(0, base - Math.round(v));
    }
    return { levels: levels, lessons: levels * 8, bundlePct: Math.round(pk.off * 100), list: list, base: base, fin: fin, extra: base - fin, egpBase: egpFromUsd(base), egpFin: egpFromUsd(fin) };
  }

  /* ---- the message */
  var AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  var AR_LEVELS = { 1: "مستوى واحد (8 حصص)", 2: "مستويان (16 حصة)", 3: "ثلاثة مستويات (24 حصة)" };
  var AR_LEVELS_SHORT = { 1: "مستوى واحد", 2: "مستويان", 3: "ثلاثة مستويات" };
  function untilText(d, ar) {
    if (!d) return "";
    var p = String(d).split("-"); if (p.length !== 3) return "";
    return ar ? +p[2] + " " + AR_MONTHS[+p[1] - 1] + " " + p[0] : prettyDate(d);
  }
  function priceText(usd, egp, ar, cur) {
    var e = ar ? n0(egp) + " جنيه" : "EGP " + n0(egp), u = ar ? n0(usd) + " دولار" : "$" + n0(usd);
    if (cur === "egp") return e;
    if (cur === "usd") return u;
    return ar ? u + " (حوالي " + e + ")" : u + " (about " + e + ")";
  }
  function levelLabel(o, ar) {
    if (ar) return AR_LEVELS[o.levels] + (o.bundlePct ? "، خصم الباقة " + o.bundlePct + "%" : "");
    return (o.levels === 1 ? "1 level (8 lessons)" : o.levels + " levels (" + o.lessons + " lessons)") + (o.bundlePct ? ", " + o.bundlePct + "% package discount" : "");
  }
  function programBlock(key, ar, m) {
    var lines = (m.packs ? [1, 2, 3] : [1]).map(function (lv) {
      var o = offerFor(key, lv), now = priceText(o.fin, o.egpFin, ar, m.cur);
      if (o.extra) return "• " + levelLabel(o, ar) + ": " + now + (ar ? "، بدل " : ", was ") + priceText(o.base, o.egpBase, ar, m.cur);
      return "• " + levelLabel(o, ar) + ": " + now;
    });
    return lines.join("\n");
  }
  function buildMessage() {
    pmState();
    var m = UI.pm, d = UI.disc, ar = m.lang === "ar", cfg = S.settings || {}, rate = roundRate(liveRate());
    var keys = m.program === "all" ? Object.keys(PRICES) : [m.program], many = keys.length > 1, out = [];
    out.push("*CLEAR English Academy*");
    out.push(ar ? "*قائمة " + (many ? "الأسعار" : "أسعار " + PRICES[keys[0]].ar) + "*" : "*" + (many ? "Price list" : PRICES[keys[0]].name + ": price list") + "*");
    out.push("");
    var two = progMins(keys[0]) === 120;
    if (many) {
      out.push(ar
        ? "كل مستوى 8 حصص أونلاين فردي (واحد لواحد): مدة الحصة ساعة، وساعتان في الآيلتس. ويشمل اختبار تحديد المستوى، وتقرير المستوى مع الخطة، والوصول لمواد الحصص ومواد المذاكرة الذاتية."
        : "Each level is 8 lessons, one to one online: one hour each, and two hours each for IELTS. It includes a placement test, a level report and plan, access to your lesson materials and self-study resources.");
    } else {
      out.push(ar
        ? "كل مستوى 8 حصص، مدة الحصة " + (two ? "ساعتان" : "ساعة") + "، أونلاين فردي (واحد لواحد). ويشمل اختبار تحديد المستوى، وتقرير المستوى مع الخطة، والوصول لمواد الحصص ومواد المذاكرة الذاتية."
        : "Each level is 8 " + (two ? "two-hour" : "one-hour") + " lessons, one to one online. It includes a placement test, a level report and plan, access to your lesson materials and self-study resources.");
    }
    out.push("");
    if (many) {
      keys.forEach(function (k) { out.push("*" + (ar ? PRICES[k].ar : PRICES[k].name) + "*"); out.push(programBlock(k, ar, m)); out.push(""); });
    } else {
      out.push(ar ? "*الأسعار*" : "*Prices*"); out.push(programBlock(keys[0], ar, m)); out.push("");
    }
    if (discOn()) {
      var desc = d.type === "pct" ? (ar ? "خصم " + Number(d.value) + "%" : Number(d.value) + "% off") : (ar ? "خصم " + n0(d.value) + " دولار على كل باقة" : "$" + n0(d.value) + " off each package");
      var lvls = [1, 2, 3].filter(function (l) { return d.levels[l] && (m.packs || l === 1); });
      var all = [1, 2, 3].filter(function (l) { return m.packs || l === 1; });
      var line = (ar ? "*العرض:* " : "*Offer:* ") + (d.label ? d.label + " – " : "") + desc + ".";
      if (lvls.length < all.length) line += (ar ? " ينطبق على: " : " Applies to: ") + lvls.map(function (l) { return ar ? AR_LEVELS_SHORT[l] : (l === 1 ? "1 level" : l + " levels"); }).join(ar ? "، " : ", ") + ".";
      if (d.until) line += (ar ? " ساري حتى " : " Valid until ") + untilText(d.until, ar) + ".";
      out.push(line); out.push("");
    }
    out.push(ar ? "*طريقة الدفع*" : "*How to pay*");
    if (m.insta && cfg.instapay) out.push((ar ? "إنستا باي: " : "InstaPay: ") + cfg.instapay);
    out.push(ar
      ? "بعد الدفع ابعتلنا صورة التحويل على واتساب +20 112 022 3509 وهنبعتلك الإيصال ونحجز لك مواعيد الحصص."
      : "After you pay, send us a screenshot on WhatsApp +20 112 022 3509. We will send your receipt and book your lessons.");
    out.push("");
    if (m.terms) {
      out.push(ar
        ? "*ملحوظة:* حصص كل مستوى (8 حصص) صالحة لمدة 10 أسابيع من أول حصة، ويمكن تأجيل الحصة بإخطارنا قبلها بـ 24 ساعة على الأقل."
        : "*Good to know:* the 8 lessons of each level are valid for 10 weeks from the first lesson. Lessons can be rescheduled with at least 24 hours' notice.");
    }
    if (m.cur !== "usd") {
      out.push(ar ? "الأسعار بالجنيه محسوبة على سعر " + rate + " جنيه للدولار، وقد تتغير مع سعر الصرف." : "EGP prices are worked out at EGP " + rate + " per $1 and can change with the exchange rate.");
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  }

  /* ---- the page */
  function priceCards() {
    return Object.keys(PRICES).map(function (k) {
      var rows = [1, 2, 3].map(function (lv) {
        var o = offerFor(k, lv);
        var price = o.extra ? "<s>" + esc(money(o.base)) + "</s> <b>" + esc(money(o.fin)) + "</b>" : "<b>" + esc(money(o.base)) + "</b>";
        var sub = o.lessons + " lessons" + (progMins(k) === 120 ? " of 2 hours" : "") + (o.bundlePct ? ", " + o.bundlePct + "% package discount (list " + money(o.list) + ")" : "");
        return '<div class="prow"><span>' + (lv === 1 ? "1 level" : lv + " levels") + '<br><span class="sub">' + esc(sub) + '</span></span><span class="pr">' + price +
          '<br><span class="sub">about ' + esc(money(o.extra ? o.egpFin : o.egpBase, "EGP")) + (o.extra ? " · saves " + esc(money(o.extra)) : "") + "</span></span></div>";
      }).join("");
      return '<div class="pcard"><h3>' + esc(PRICES[k].name) + "</h3>" + rows + "</div>";
    }).join("");
  }
  function pmWarning() {
    var cfg = S.settings || {};
    if (UI.pm.insta && !cfg.instapay) return hasPriceCols() ? 'No InstaPay number saved yet, so the message leaves that line out. Add it in <a href="#/account">Account</a>.' : 'The InstaPay number needs the one-time database update first. See <a href="#/account">Account</a>.';
    return "";
  }
  function viewPrices() {
    pmState();
    var cfg = S.settings || {}, d = UI.disc, m = UI.pm;
    var chk = function (name, on, label) { return '<label class="chk"><input type="checkbox" data-pc="1" name="' + name + '"' + (on ? " checked" : "") + "> " + label + "</label>"; };
    var rateLine = "Prices are fixed in dollars. EGP prices use <b>EGP " + roundRate(liveRate()) + "</b> per $1" + (cfg.rate_updated_at ? " (updated " + esc(fmtStamp(cfg.rate_updated_at)) + (cfg.rate_source ? ", " + esc(cfg.rate_source) : "") + ")" : "") + ", to the nearest 10 pounds.";
    return '<div class="acts" style="margin-top:16px"><p class="hint" style="flex:1 1 260px">' + rateLine + '</p><button type="button" class="btn sec sm" data-act="fetchrate">Update to today\'s rate</button></div>' +
      '<div class="pgrid" style="margin-top:12px"><div class="panel" style="gap:14px"><div><h2>Discount</h2><p class="hint">Switch it on to see it in the prices below and in the message. You choose the percentage or the amount.</p></div>' +
        chk("d_on", d.on, "<b>Apply a discount</b>") +
        '<div class="fields"><div class="f"><label for="dt">Type</label><select id="dt" data-pc="1" name="d_type"><option value="pct"' + (d.type === "pct" ? " selected" : "") + '>Percentage off</option><option value="amt"' + (d.type === "amt" ? " selected" : "") + '>Amount off each package ($)</option></select></div>' +
        '<div class="f"><label for="dv">Value <span id="dunit">' + (d.type === "pct" ? "(%)" : "($)") + '</span></label><input id="dv" data-pc="1" name="d_value" type="number" min="0" step="any" inputmode="decimal" value="' + esc(d.value) + '"></div>' +
        '<div class="f"><label for="dl">Offer name (optional)</label><input id="dl" data-pc="1" name="d_label" placeholder="e.g. Launch offer" value="' + esc(d.label) + '"></div>' +
        '<div class="f"><label for="du">Valid until (optional)</label><input id="du" data-pc="1" name="d_until" type="date" value="' + esc(d.until) + '"></div></div>' +
        '<div><span class="label">Applies to</span><div class="acts">' + chk("d_l1", d.levels[1], "1 level") + chk("d_l2", d.levels[2], "2 levels") + chk("d_l3", d.levels[3], "3 levels") + "</div></div>" +
        '<p class="hint">The percentage comes off the price after the package discount. A dollar amount comes off each package you tick.</p></div>' +
      '<div class="panel" style="gap:14px"><div><h2>Message options</h2><p class="hint">What goes into the message you copy.</p></div><div class="fields">' +
        '<div class="f"><label for="mp">Program</label><select id="mp" data-pc="1" name="m_program"><option value="all"' + (m.program === "all" ? " selected" : "") + ">All programs</option>" + opt(Object.keys(PRICES), m.program, mapNames()) + "</select></div>" +
        '<div class="f"><label for="ml">Language</label><select id="ml" data-pc="1" name="m_lang"><option value="en"' + (m.lang === "en" ? " selected" : "") + '>English</option><option value="ar"' + (m.lang === "ar" ? " selected" : "") + ">Arabic (العربية)</option></select></div>" +
        '<div class="f"><label for="mc">Show prices in</label><select id="mc" data-pc="1" name="m_cur"><option value="both"' + (m.cur === "both" ? " selected" : "") + '>Dollars and EGP</option><option value="usd"' + (m.cur === "usd" ? " selected" : "") + '>Dollars only</option><option value="egp"' + (m.cur === "egp" ? " selected" : "") + ">EGP only</option></select></div></div>" +
        '<div class="acts">' + chk("m_packs", m.packs, "2 and 3 level packages") + chk("m_insta", m.insta, "InstaPay number") + chk("m_terms", m.terms, "Key terms") + "</div></div></div>" +
      '<h3 style="margin:22px 0 4px">Price list <span id="discstate">' + (discOn() ? '<span class="pill warn">Discount on</span>' : "") + '</span></h3><div id="plist" class="pgrid">' + priceCards() + "</div>" +
      '<div class="panel msgbox" style="margin-top:22px;gap:12px"><div><h2>Message to send</h2><p class="hint">Edit it freely. Changing an option above writes it again from scratch.</p></div>' +
        '<p class="hint" id="pmwarn" style="color:var(--warn)">' + pmWarning() + "</p>" +
        '<textarea id="msgtext" rows="16" dir="' + (m.lang === "ar" ? "rtl" : "ltr") + '" aria-label="Message to send">' + esc(buildMessage()) + "</textarea>" +
        '<div class="acts"><button type="button" class="btn" data-act="copymsg">Copy message</button><button type="button" class="btn sec" data-act="wamsg">Open in WhatsApp</button></div></div>';
  }
  function readPC() {
    var g = function (nm) { return $('[data-pc][name="' + nm + '"]'); };
    var v = function (nm) { var e = g(nm); return e ? e.value : ""; };
    var c = function (nm) { var e = g(nm); return !!(e && e.checked); };
    if (!g("m_program")) return false;
    UI.pm = { program: v("m_program"), lang: v("m_lang"), cur: v("m_cur"), insta: c("m_insta"), terms: c("m_terms"), packs: c("m_packs") };
    UI.disc = { on: c("d_on"), type: v("d_type"), value: v("d_value"), label: v("d_label"), until: v("d_until"), levels: { 1: c("d_l1"), 2: c("d_l2"), 3: c("d_l3") } };
    savePM(); return true;
  }
  /* controls change the price cards and the message in place, so typing is never interrupted */
  function livePrices(e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute("data-pc")) return false;
    if (!readPC()) return true;
    var pl = $("#plist"); if (pl) pl.innerHTML = priceCards();
    var ta = $("#msgtext"); if (ta) { ta.value = buildMessage(); ta.setAttribute("dir", UI.pm.lang === "ar" ? "rtl" : "ltr"); }
    var u = $("#dunit"); if (u) u.textContent = UI.disc.type === "pct" ? "(%)" : "($)";
    var st = $("#discstate"); if (st) st.innerHTML = discOn() ? '<span class="pill warn">Discount on</span>' : "";
    var w = $("#pmwarn"); if (w) w.innerHTML = pmWarning();
    return true;
  }
  function payEqText(amount, cur, rate) {
    amount = Number(amount); rate = Number(rate);
    if (!(amount > 0 && rate > 0)) return "";
    if (cur === "USD") return "About " + money(Math.round(amount * rate), "EGP") + " at EGP " + roundRate(rate) + " per $1.";
    return "About " + money(Math.round(amount / rate * 100) / 100) + " at EGP " + roundRate(rate) + " per $1.";
  }
  function payEq(form) {
    var box = $("[data-eq]", form); if (!box) return;
    box.textContent = payEqText(form.amount.value, form.currency.value, form.egp_rate.value);
  }

  function payToggle() {
    return '<label class="chk" style="margin-top:16px;display:flex"><input type="checkbox" data-change="paytoday"' + (UI.payToday ? " checked" : "") + '> Show dollar payments at today\'s rate (EGP ' + roundRate(liveRate()) + ") instead of the rate when each was received</label>";
  }
  function viewPayments() {
    var tab = UI.payTab || "ledger";
    return '<div class="tabs" role="group" aria-label="Payments sections" style="margin-top:16px"><button type="button" data-act="paytab" data-v="ledger" aria-pressed="' + (tab === "ledger") + '">Payments</button><button type="button" data-act="paytab" data-v="prices" aria-pressed="' + (tab === "prices") + '">Price list and message</button></div>' +
      (tab === "prices" ? viewPrices() : viewLedger());
  }

  /* ------------------------------------------------------------ admin: payments ledger */
  function viewLedger() {
    var pays = S.payments.slice().sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
    var usd = 0, egp = 0, all = 0; pays.forEach(function (p) { all += egpView(p); if (p.currency === "EGP") egp += Number(p.amount); else usd += Number(p.amount); });
    var usdAsEgp = all - egp;
    var rows = pays.map(function (p) {
      return '<div class="lrow" style="grid-template-columns:110px minmax(0,1fr) auto"><span class="tm">' + esc(p.receipt_no) + '</span><span><a href="#/students/' + p.student_id + '">' + esc(studentName(p.student_id)) + '</a><br><span class="sub">' + esc(p.paid_on) + " · " + esc(p.method) + (p.reference ? " · " + esc(p.reference) : "") + '</span></span><span style="text-align:right"><b>' + money(p.amount, p.currency) + "</b>" +
        (p.currency === "USD" && egpView(p) ? '<br><span class="sub">about ' + money(egpView(p), "EGP") + "</span>" : "") +
        '<br><button type="button" class="linkbtn sub" data-act="openreceipt" data-id="' + p.id + '">Receipt</button></span></div>';
    }).join("");
    return payToggle() + '<div class="sum"><div><span class="label">Received in USD</span><b>' + money(usd) + "</b>" + (usd ? "<small>about " + money(usdAsEgp, "EGP") + "</small>" : "") + "</div>" +
      '<div><span class="label">Received in EGP</span><b>' + money(egp, "EGP") + "</b></div>" +
      '<div><span class="label">Total in EGP</span><b>' + money(all, "EGP") + "</b><small>" + (UI.payToday ? "USD converted at today's rate" : "USD converted at the rate of each payment") + "</small></div>" +
      '<div><span class="label">Receipts issued</span><b>' + pays.length + "</b></div></div>" +
      (pays.length ? '<div class="acts" style="margin-bottom:12px"><button type="button" class="btn sec sm" data-act="csv">Download as CSV</button></div><div class="list">' + rows + "</div>" : '<div class="empty"><b>No payments yet</b>Record a payment from a student\'s package.</div>');
  }
  function exportCsv() {
    var head = ["receipt_no", "paid_on", "student", "amount", "currency", "egp_rate", "egp_equivalent", "method", "reference"];
    var lines = [head.join(",")].concat(S.payments.map(function (p) {
      return [p.receipt_no, p.paid_on, studentName(p.student_id), p.amount, p.currency, p.egp_rate || "", egpOf(p) || "", p.method, p.reference || ""].map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(",");
    }));
    download("clear-payments-" + todayStr() + ".csv", lines.join("\n"), "text/csv");
  }

  /* ------------------------------------------------------------ admin: account */
  function viewAccount() {
    var cfg = S.settings || {}, cols = hasPriceCols();
    var rateInfo = cfg.rate_updated_at ? "Updated " + fmtStamp(cfg.rate_updated_at) + (cfg.rate_source ? " from " + cfg.rate_source : "") + "." : (cols ? "Not updated from the internet yet." : "");
    var setup = cols || !S.settings ? "" :
      '<div class="panel" style="margin-top:20px;max-width:520px"><div><h2>One-time database update</h2><p class="hint">To save the InstaPay number and the time the rate was updated, run this once: open your Supabase project, choose SQL Editor, paste it and press Run. Everything else works without it.</p></div>' +
      '<pre class="sql">' + esc(SETUP_SQL) + '</pre><div class="acts"><button type="button" class="btn sec" data-act="copysql">Copy the SQL</button></div></div>';
    return '<div class="panel" style="margin-top:20px;max-width:520px"><div><h2>Academy settings</h2><p class="hint">Used when you record payments, price packages and build lessons.</p></div>' +
      '<form data-form="saverate"><div class="fields" style="grid-template-columns:1fr"><div class="f"><label for="sr">USD to EGP rate (EGP for $1)</label>' +
      '<div class="acts" style="flex-wrap:wrap"><input id="sr" name="usd_egp_rate" type="number" step="0.0001" min="1" required style="flex:1 1 140px;width:auto" value="' + esc(cfg.usd_egp_rate) + '"><button type="button" class="btn sec" data-act="fetchrate">Update to today\'s rate</button></div>' +
      '<span class="hint">' + esc(rateInfo) + ' The button fetches the current market rate and asks you to confirm before saving. Compare it with your bank or InstaPay rate if you need to, and type your own number if you prefer. Prices are fixed in dollars; EGP prices and new payments use this rate. Each payment already recorded keeps the rate it was received at.</span></div>' +
      '<div class="f"><label for="si">InstaPay number or address</label><input id="si" name="instapay" placeholder="e.g. 01xxxxxxxxx or name@instapay"' + (cols ? "" : " disabled") + ' value="' + esc(cfg.instapay) + '"><span class="hint">' + (cols ? "Goes into the price message you copy from Payments." : "Needs the one-time database update below.") + "</span></div>" +
      '<div class="f"><label for="sl">Default lesson link (Zoom or Google Meet)</label><input id="sl" name="default_meeting_url" type="url" placeholder="https://" value="' + esc(cfg.default_meeting_url) + '"><span class="hint">New lessons get this link. Students see a Join button.</span></div></div>' +
      '<div class="acts" style="margin-top:10px"><button class="btn" type="submit">Save settings</button><button type="button" class="btn sec" data-act="applylink">Use the link for lessons that have none</button></div></form></div>' +
      setup +
      '<div class="panel" style="margin-top:20px;max-width:520px"><div><h2>Account</h2><p class="hint">Signed in as ' + esc(me.email) + '. Role: ' + esc(me.role) + '.</p></div>' +
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
      (r.summary ? "<div><h3>" + (r.checkpoint ? "How it is going" : "Summary") + "</h3><p>" + esc(r.summary) + "</p></div>" : "") +
      (r.goals ? "<div><h3>Your goals</h3><p>" + esc(r.goals) + "</p></div>" : "") +
      (skills ? "<div><h3>Skills</h3>" + skills + "</div>" : "") +
      (recs ? "<div><h3>Recommendations</h3><ul>" + recs + "</ul></div>" : "") +
      (objs ? "<div><h3>" + (r.checkpoint ? "What to practise next" : "Level objectives") + "</h3><ol>" + objs + "</ol></div>" : "") +
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
  function checkpointEditor(r, s) {
    return '<form data-form="savereport" data-id="' + r.id + '" class="panel"><div><h2>' + esc(CHECKPOINTS[r.checkpoint]) + " · " + esc(s.full_name) + '</h2><p class="hint">A short update for the student. They see it only after you publish it.</p></div>' +
      '<input type="hidden" name="kind" value="' + esc(r.kind) + '"><div class="fields">' +
      '<div class="f"><label for="rti">Title</label><input id="rti" name="title" value="' + esc(r.title) + '"></div>' +
      '<div class="f"><label for="rc">Level now (optional)</label><select id="rc" name="cefr"><option value="">Not set</option>' + opt(CEFR, r.cefr) + "</select></div>" +
      '<div class="f"><label for="rb">Written by</label><input id="rb" name="assessed_by" value="' + esc(r.assessed_by || "CLEAR Academic Team") + '"></div>' +
      '<div class="f wide"><label for="rs">How the lessons are going</label><textarea id="rs" name="summary" style="min-height:140px">' + esc(r.summary) + '</textarea></div>' +
      '<div class="f wide"><label for="ro">What to practise next (one point per line)</label><textarea id="ro" name="objectives" style="min-height:110px">' + esc((r.objectives || []).join("\n")) + "</textarea></div></div>" +
      '<div class="acts"><button class="btn sec" type="submit" data-pub="0">' + (r.published ? "Unpublish and save" : "Save draft") + '</button>' + (r.published ? '<button class="btn" type="submit" data-pub="1">Save changes</button>' : '<button class="btn" type="submit" data-pub="1">Save and publish to the student</button>') + '<button type="button" class="btn danger" data-act="delreport" data-id="' + r.id + '">Delete</button></div></form>';
  }
  function reportEditor(r, s) {
    if (r.checkpoint) return checkpointEditor(r, s);
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
  function viewTz() {
    if (!UI.viewTz) { try { UI.viewTz = localStorage.getItem("clear-viewtz"); } catch (e) { /* storage blocked */ } }
    try { new Intl.DateTimeFormat("en", { timeZone: UI.viewTz || "" }); } catch (e) { UI.viewTz = null; }
    if (!UI.viewTz) UI.viewTz = myTz();
    return UI.viewTz;
  }
  function converted(iso) {
    var tz = viewTz(); if (tz === EG) return "";
    return '<span class="hint">In your time, ' + esc(tzLabel(tz)) + ": <b>" + esc(fmtDT(iso, tz)) + "</b></span>";
  }
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
    var dueBox = s.payment_due ? '<div class="paydue" role="alert"><b>Payment due</b><span>Your new level' + (s.payment_due_note ? " (" + esc(s.payment_due_note) + ")" : "") + ' has not been paid yet. Please pay by InstaPay and send your receipt to your teacher on WhatsApp so your lessons stay active.</span></div>' : "";
    return '<div style="margin-top:20px;display:grid;gap:22px">' + dueBox +
      '<div class="sum" style="margin:0"><div><span class="label">Hello</span><b>' + esc(s.full_name.split(" ")[0]) + '</b></div><div><span class="label">Your level</span><b>' + esc(s.level_code || s.cefr || "To be tested") + '</b></div><div><span class="label">Next lesson</span><b style="font-size:17px">' + (next ? esc(fmtDT(next.starts_at)) + "</b><small>Egypt time</small>" + (viewTz() !== EG ? "<small>" + converted(next.starts_at) + "</small>" : "") : "Not scheduled yet</b>") + "</div></div>" +
      studentHomework(s) +
      '<div class="panel"><div class="sec"><h3>Your lessons</h3><div class="f" style="max-width:360px"><label for="vtz">Show lessons in my time zone</label><select id="vtz" data-change="viewtz">' + tzOptions(viewTz()) + '</select></div><p class="hint">Lessons are set in Egypt time.</p><div class="cards">' + (upcoming.concat(past).length ? upcoming.concat(past).map(function (l) {
        return '<div class="card"><div class="l1"><span class="t">' + esc(fmtDT(l.starts_at)) + " Egypt time · " + l.duration_min + ' min</span><span class="pill' + (l.status === "completed" ? " ok" : "") + '">' + esc(LSTATUS[l.status]) + "</span></div>" + (converted(l.starts_at) ? converted(l.starts_at) : "") + lessonFiles(l) +
          (l.topic ? '<span class="hint">' + esc(l.topic) + "</span>" : "") + (l.summary ? "<p>" + esc(l.summary) + "</p>" : "") +
          (l.meeting_url && l.status === "scheduled" ? '<div class="acts"><a class="btn sm" href="' + esc(l.meeting_url) + '" target="_blank" rel="noopener">Join lesson</a></div>' : "") + "</div>";
      }).join("") : '<p class="hint">Your lessons will appear here once they are scheduled.</p>') + "</div>" +
      '<p class="hint">To move a lesson, message the academy at least 24 hours before it starts. <a href="' + WHATSAPP + '" target="_blank" rel="noopener">WhatsApp the academy</a>.</p></div>' +
      '<div class="sec"><h3>Your materials</h3><div class="cards">' + (S.materials.filter(function (m) { return m.student_id === s.id; }).map(function (m) { return materialRow(m, false); }).join("") || '<p class="hint">Slides and handouts from your lessons will appear here.</p>') + "</div></div>" +
      (pkgs.length ? '<div class="sec"><h3>Your package</h3><div class="cards">' + pkgs.map(function (p) {
        return '<div class="card"><div class="l1"><span class="t">' + esc(pkgLabel(p)) + '</span><span class="pill ' + (pkgIsPaid(p) ? "ok" : "warn") + '">' + (pkgIsPaid(p) ? "Paid" : "Payment due") + '</span></div><span class="hint">' + pkgUsed(p) + " of " + p.lessons_total + " lessons used" + (p.expires_on ? " · valid until " + esc(p.expires_on) : "") + "</span></div>";
      }).join("") + "</div></div>" : "") +
      (pays.length ? '<div class="sec"><h3>Your receipts</h3><div class="cards">' + pays.map(function (x) {
        return '<div class="card"><div class="l1"><span><b>' + money(x.amount, x.currency) + "</b> · " + esc(x.paid_on) + '</span><span class="pills"><span class="pill ok">' + esc(x.receipt_no) + '</span><button type="button" class="btn sec sm" data-act="openreceipt" data-id="' + x.id + '">Open receipt</button></span></div></div>';
      }).join("") + "</div></div>" : "") + "</div>" +
      '<div class="panel" style="max-width:520px"><div class="sec"><h3>Sign-in password</h3><p class="hint">Optional. Set a password so you can sign in with your email and password next time. You can change it here whenever you like.</p><form data-form="setpw"><div class="f"><label for="np">New password</label><input id="np" name="password" type="password" minlength="8" autocomplete="new-password" required><span class="hint">At least 8 characters.</span></div><div class="acts" style="margin-top:10px"><button class="btn" type="submit">Save password</button></div></form></div></div>' +
      (reps.length ? '<div><h3 style="margin-bottom:12px">Your reports</h3><div style="display:grid;gap:16px">' + reps.map(function (r) { return reportHTML(r, s); }).join("") + '</div><div class="acts noprint" style="margin-top:12px"><button type="button" class="btn sm" data-act="print">Print or save as PDF</button></div></div>' : "") + "</div>";
  }

  /* ------------------------------------------------------------ Clear Academic (teacher section) */
  var CKINDS = { slides: "Slides", handout: "Handout", worksheet: "Worksheet", homework: "Homework", key: "Answer key", notes: "Teacher notes", audio: "Audio", other: "Other" };
  var CKIND_TO_MKIND = { slides: "slides", handout: "handout", worksheet: "worksheet", homework: "homework", audio: "recording", other: "other" };
  var CSTATUS = { outline: "Outline", drafting: "Drafting", ready: "Ready" };
  var SRC_KINDS = { coursebook: "Coursebook", teachers_book: "Teacher's book", workbook: "Workbook", standard: "Standard", wordlist: "Word list", website: "Website", other: "Other" };
  var SRC_CHECKED = { opened: "Opened and checked", purchased: "Purchased copy", from_memory: "From memory, not checked" };
  var CHECKPOINTS = { after_1: "After lesson 1", after_4: "After lesson 4", final: "Final report" };
  var BLUEPRINT = "0-5 min  Warm-up and homework check (speak first, no slides)\n5-15 min  Present the target language (3-5 slides, examples from the learner's life)\n15-30 min  Controlled, then guided practice\n30-45 min  Speaking task (the main output)\n45-55 min  Feedback on errors (3-5 errors recorded live, learner corrects them)\n55-60 min  Recap: \"I can ...\"; set homework";

  function loadAcademic() {
    var admin = me && me.role === "admin";
    var q = function (name, col) {
      var x = sb.from(name).select("*"); if (col) x = x.order(col, { ascending: true });
      return Promise.resolve(x).then(function (r) { return r.error ? null : (r.data || []); }, function () { return null; });
    };
    return Promise.all([
      admin ? q("cur_levels", "position") : Promise.resolve([]), admin ? q("cur_lessons", "number") : Promise.resolve([]),
      admin ? q("cur_files", "created_at") : Promise.resolve([]), admin ? q("cur_sources", "position") : Promise.resolve([]), q("assignments", "created_at"), admin ? q("level_results", "decided_at") : Promise.resolve([])
    ]).then(function (r) {
      S.academicReady = !admin || (r[0] !== null && r[1] !== null && r[2] !== null && r[3] !== null);
      S.cur_levels = r[0] || []; S.cur_lessons = r[1] || []; S.cur_files = r[2] || []; S.cur_sources = r[3] || [];
      S.level_results = r[5] || []; S.assignments = (r[4] || []).slice().sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
    });
  }
  function levelOf(l) { return byId(S.cur_levels, l.level_id) || { code: "", position: 1, name: "" }; }
  function lessonNo(l) { return (levelOf(l).position - 1) * 8 + l.number; }
  function curLabel(l) { return levelOf(l).code + " · " + l.number + ". " + l.title; }
  function curFiles(lid) { return S.cur_files.filter(function (f) { return f.lesson_id === lid; }); }
  function curOptions(sel) {
    return '<option value="">No curriculum lesson</option>' + S.cur_levels.map(function (lv) {
      return '<optgroup label="' + esc(lv.code + " " + lv.name) + '">' + S.cur_lessons.filter(function (l) { return l.level_id === lv.id; }).sort(function (a, b) { return a.number - b.number; }).map(function (l) {
        return '<option value="' + l.id + '"' + (l.id === sel ? " selected" : "") + ">" + esc(l.number + ". " + l.title) + "</option>";
      }).join("") + "</optgroup>";
    }).join("");
  }
  function checkpointStrip(s) {
    if (!S.academicReady) return "";
    var items = checkpointItems().filter(function (x) { return x.s.id === s.id; });
    if (!items.length) return "";
    var rows = items.map(function (x) {
      var st = x.rep ? '<span class="pill ok">' + (x.rep.published ? "Sent" : "Draft") + "</span>" : x.due ? '<span class="pill warn">Due now</span>' : '<span class="pill">After lesson ' + x.need + " (" + x.used + " done)</span>";
      var btn = x.rep ? '<button type="button" class="btn sec sm" data-act="editreport" data-id="' + x.rep.id + '">Open</button>' : x.due ? '<button type="button" class="btn sm" data-act="newcp" data-id="' + s.id + '" data-v="' + x.cp + '">Write it</button>' : "";
      return '<div class="card"><div class="l1"><span class="t">' + esc(CHECKPOINTS[x.cp]) + '</span><span class="pills">' + st + btn + "</span></div></div>";
    }).join("");
    return '<div class="sec"><h3>Feedback checkpoints</h3><div class="cards">' + rows + "</div></div>";
  }
  function hwDue() { return S.assignments.filter(function (a) { return a.status === "submitted"; }).length; }
  function checkpointItems() {
    var out = [];
    S.students.forEach(function (s) {
      if (s.status !== "active" && s.status !== "paused") return;
      var pkg = activePackage(s.id); if (!pkg) return;
      var used = pkgUsed(pkg);
      [["after_1", 1], ["after_4", 4], ["final", pkg.lessons_total]].forEach(function (cp) {
        var rep = S.reports.filter(function (r) { return r.student_id === s.id && r.checkpoint === cp[0] && r.created_at >= pkg.created_at; })[0] || null;
        out.push({ s: s, cp: cp[0], need: cp[1], used: used, rep: rep, due: !rep && used >= cp[1] });
      });
    });
    return out;
  }
  function fbDue() { return checkpointItems().filter(function (x) { return x.due; }).length; }

  function viewAcademic(tab, id) {
    if (!S.academicReady) {
      return '<div class="empty" style="margin-top:20px"><b>Clear Academic needs one setup step</b>Run the file <code>supabase/migrations/005_clear_academic.sql</code> once in the Supabase SQL editor, then reload this page.</div>';
    }
    if (tab === "lesson" && byId(S.cur_lessons, id)) return acLesson(byId(S.cur_lessons, id));
    var hw = hwDue(), fb = fbDue();
    var tabs = [["plan", "Plan"], ["schedule", "Schedule"], ["homework", "Homework" + (hw ? " (" + hw + ")" : "")], ["feedback", "Feedback" + (fb ? " (" + fb + ")" : "")], ["sources", "Sources"], ["import", "Import files"]];
    var cur = tabs.some(function (t) { return t[0] === tab; }) ? tab : "plan";
    var body = cur === "schedule" ? acSchedule() : cur === "homework" ? acHomework() : cur === "feedback" ? acFeedback() : cur === "sources" ? acSources() : cur === "import" ? acImport() : acPlan();
    return '<div style="margin-top:18px;display:grid;gap:18px"><div class="tabs noprint" role="group" aria-label="Clear Academic">' + tabs.map(function (t) {
      return '<button type="button" data-act="actab" data-v="' + t[0] + '" aria-pressed="' + (cur === t[0]) + '">' + esc(t[1]) + "</button>";
    }).join("") + "</div>" + body + "</div>";
  }

  /* ---- plan */
  function acPlan() {
    var total = S.cur_lessons.length, ready = S.cur_lessons.filter(function (l) { return l.status === "ready"; }).length;
    return '<div class="sum" style="margin:0"><div><span class="label">Program</span><b style="font-size:17px">General English A1</b></div><div><span class="label">Levels</span><b>' + S.cur_levels.filter(function (x) { return x.cefr !== "Special"; }).length + '</b></div><div><span class="label">Lessons ready</span><b>' + ready + " / " + total + "</b></div></div>" +
      S.cur_levels.map(function (lv) {
        var ls = S.cur_lessons.filter(function (l) { return l.level_id === lv.id; }).sort(function (a, b) { return a.number - b.number; });
        return '<div class="panel"><div><h2>' + esc(lv.code) + " " + esc(lv.name) + '</h2><p class="hint">' + esc(lv.summary || "") + '</p></div><div class="cards">' + ls.map(function (l) {
          var n = curFiles(l.id).length;
          return '<div class="card"><div class="l1"><span class="t">' + lessonNo(l) + ". " + esc(l.title) + '</span><span class="pills"><span class="pill ' + (l.status === "ready" ? "ok" : l.status === "drafting" ? "warn" : "") + '">' + esc(CSTATUS[l.status]) + '</span><span class="pill">' + n + (n === 1 ? " file" : " files") + "</span></span></div>" +
            '<span class="hint">' + esc(l.objective || "") + (l.navigate_ref ? " · Navigate " + esc(l.navigate_ref) : "") + "</span>" +
            (!l.plan ? '<span class="hint" style="color:var(--warn,#e0a526)">The staged plan is not written yet.</span>' : "") +
            '<div class="acts"><button type="button" class="btn sec sm" data-act="aclesson" data-id="' + l.id + '">Open lesson kit</button>' +
            '<label class="hint" for="cs' + l.id + '" style="margin-left:auto">Status</label><select id="cs' + l.id + '" data-change="curstatus" data-id="' + l.id + '" aria-label="Lesson status" style="width:auto">' + opt(Object.keys(CSTATUS), l.status, CSTATUS) + "</select></div></div>";
        }).join("") + "</div></div>";
      }).join("");
  }

  /* ---- one lesson: details, files, send */
  function curFileRow(f) {
    return '<div class="card" id="cf' + f.id + '"><div class="l1"><span class="t">' + esc(f.title) + '</span><span class="pills"><span class="pill">' + esc(CKINDS[f.kind] || f.kind) + '</span><span class="pill ' + (f.for_student ? "ok" : "warn") + '">' + (f.for_student ? "Student can receive" : "Teacher only") + "</span></span></div>" +
      '<span class="hint">' + esc(f.file_name) + " · " + esc(fmtSize(f.size_bytes)) + "</span>" +
      '<div class="acts">' + (/^audio\//.test(f.mime || "") ? '<button type="button" class="btn sm" data-act="playcur" data-id="' + f.id + '">Play here</button>' : "") + (viewableCopy(f) ? '<button type="button" class="btn sm" data-act="viewcur" data-id="' + f.id + '">View</button>' : "") + '<button type="button" class="btn sm sec" data-act="opencur" data-id="' + f.id + '">Open or download</button><button type="button" class="btn danger sm" data-act="delcur" data-id="' + f.id + '">Delete</button></div></div>';
  }
  function acLesson(l) {
    var lv = levelOf(l), files = curFiles(l.id), sendable = files.filter(function (f) { return f.for_student; });
    var students = S.students.filter(function (s) { return s.status !== "inactive" && s.status !== "completed"; });
    var now = new Date().toISOString();
    var up = S.lessons.filter(function (x) { return x.status === "scheduled" && x.starts_at >= now; }).sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; });
    var linked = up.filter(function (x) { return x.cur_lesson_id === l.id; })[0];
    var fld = function (name, label, val, tall, wide) {
      return '<div class="f' + (wide === false ? "" : " wide") + '"><label for="c_' + name + '">' + label + '</label><textarea id="c_' + name + '" name="' + name + '"' + (tall ? ' style="min-height:' + tall + 'px"' : "") + ">" + esc(val) + "</textarea></div>";
    };
    return '<div class="panel"><div class="acts noprint"><button type="button" class="btn sec sm back" data-act="actab" data-v="plan">Back to plan</button></div>' +
      '<div><span class="label">' + esc(lv.code + " " + lv.name) + " · lesson " + lessonNo(l) + '</span><h2>' + esc(l.title) + "</h2></div>" +
      '<form data-form="savecur" data-id="' + l.id + '" class="sec"><h3>Lesson plan</h3><div class="fields">' +
      '<div class="f wide"><label for="c_title">Title</label><input id="c_title" name="title" value="' + esc(l.title) + '" required></div>' +
      '<div class="f"><label for="c_status">Status</label><select id="c_status" name="status">' + opt(Object.keys(CSTATUS), l.status, CSTATUS) + "</select></div>" +
      '<div class="f"><label for="c_nav">Navigate reference (for you)</label><input id="c_nav" name="navigate_ref" value="' + esc(l.navigate_ref) + '"></div>' +
      fld("objective", "Objective: by the end the learner can ...", l.objective, 70) + fld("grammar", "Grammar", l.grammar, 60, false) + fld("vocabulary", "Vocabulary", l.vocabulary, 60, false) +
      fld("plan", "Staged plan (60 minutes)", l.plan, 170) +
      '<div class="acts wide" style="grid-column:1/-1"><button type="button" class="btn sec sm" data-act="curblueprint">Fill in the standard 60-minute plan</button></div>' +
      fld("homework", "Homework sent to the student", l.homework, 90) + fld("omitted", "Left out or replaced, and why", l.omitted, 70) + fld("culture_note", "Cultural suitability note", l.culture_note, 70) +
      fld("teacher_notes", "Private teacher notes: key, likely errors, timing", l.teacher_notes, 140) +
      '</div><div class="acts" style="margin-top:12px"><button class="btn" type="submit">Save lesson</button></div></form>' +
      '<div class="sec"><h3>Files for this lesson</h3><div class="cards">' + (files.map(curFileRow).join("") || '<p class="hint">No files yet. Upload the slides, handout, homework and your private key here once. You can then send them to any student.</p>') + "</div>" +
      '<form data-form="addcurfile" data-id="' + l.id + '" class="addbox"><div class="fields">' +
      '<div class="f wide"><label for="cf">File from your device</label><input id="cf" name="file" type="file" accept="' + FILE_ACCEPT + '" required><span class="hint">Up to 50 MB.</span></div>' +
      '<div class="f"><label for="ck">Type</label><select id="ck" name="kind">' + opt(Object.keys(CKINDS), "slides", CKINDS) + "</select></div>" +
      '<div class="f"><label for="ct">Title (optional)</label><input id="ct" name="title" placeholder="Uses the file name"></div>' +
      '<div class="f"><label for="cs">Who can receive it</label><select id="cs" name="for_student"><option value="1">Student can receive it</option><option value="0">Teacher only (key, notes)</option></select></div></div>' +
      '<div class="acts"><button class="btn" type="submit">Upload file</button></div></form></div>' +
      '<div class="sec"><h3>Send to a student</h3>' + (!sendable.length && !l.homework ? '<p class="hint">Upload at least one student file, or write the homework above, then you can send this lesson.</p>' :
        '<form data-form="sendkit" data-id="' + l.id + '" class="addbox"><div class="fields">' +
        '<div class="f"><label for="sl">For which lesson</label><select id="sl" name="lesson_id"><option value="">No specific lesson</option>' + up.map(function (x) { return '<option value="' + x.id + '"' + (linked && linked.id === x.id ? " selected" : "") + ">" + esc(studentName(x.student_id) + " · " + fmtDT(x.starts_at)) + "</option>"; }).join("") + "</select></div>" +
        '<div class="f"><label for="ss">Or choose a student</label><select id="ss" name="student_id"><option value="">Use the lesson above</option>' + students.map(function (s) { return '<option value="' + s.id + '">' + esc(s.full_name) + "</option>"; }).join("") + "</select></div></div>" +
        (sendable.length ? '<div class="f"><label>Files to send</label>' + sendable.map(function (f) { return '<label style="font-weight:400;display:flex;gap:8px;align-items:center"><input type="checkbox" name="f_' + f.id + '" value="1" checked style="width:auto"> ' + esc(f.title) + ' <span class="hint">(' + esc(CKINDS[f.kind]) + ")</span></label>"; }).join("") + "</div>" : "") +
        '<div class="f"><label style="font-weight:400;display:flex;gap:8px;align-items:center"><input type="checkbox" name="hw" value="1"' + (l.homework ? " checked" : "") + ' style="width:auto"> Also assign homework</label></div>' +
        '<div class="fields"><div class="f"><label for="hwt">Homework title</label><input id="hwt" name="hw_title" value="' + esc("Homework: " + l.title) + '"></div><div class="f"><label for="hwd">Due date</label><input id="hwd" name="hw_due" type="date"></div>' +
        '<div class="f wide"><label for="hwi">Instructions</label><textarea id="hwi" name="hw_text">' + esc(l.homework) + "</textarea></div></div>" +
        '<div class="acts"><button class="btn" type="submit">Send to the student</button></div><p class="hint">Files a student already has are skipped. Teacher-only files are never sent.</p></form>') + "</div></div>";
  }
  /* ---- in-app viewer: PDF pages drawn with pdf.js, images shown directly */
  var pdfLibP = null;
  function loadPdfLib() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfLibP) pdfLibP = new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = "vendor/pdf.min.js";
      s.onload = function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"; res(window.pdfjsLib); };
      s.onerror = function () { pdfLibP = null; rej(new Error("Could not load the viewer.")); };
      document.head.appendChild(s);
    });
    return pdfLibP;
  }
  function closeViewer() { var v = document.getElementById("dv"); if (v) v.remove(); document.removeEventListener("keydown", viewerKey); }
  var viewerState = null;
  function viewerKey(e) {
    if (!viewerState) return;
    if (e.key === "Escape") closeViewer();
    else if (e.key === "ArrowRight" || e.key === "PageDown") viewerGo(1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") viewerGo(-1);
  }
  function viewerGo(d) { if (!viewerState || !viewerState.doc) return; var n = Math.min(viewerState.doc.numPages, Math.max(1, viewerState.page + d)); if (n !== viewerState.page) { viewerState.page = n; viewerDraw(); } }
  function viewerDraw() {
    var st = viewerState, v = document.getElementById("dv"); if (!st || !v) return;
    var stage = v.querySelector(".stage"), cv = v.querySelector("canvas"), tok = ++st.tok;
    v.querySelector(".pg").textContent = st.page + " / " + st.doc.numPages;
    st.doc.getPage(st.page).then(function (pg) {
      if (tok !== st.tok) return;
      var vp0 = pg.getViewport({ scale: 1 }), avail = Math.max(280, stage.clientWidth - 28), availH = Math.max(240, stage.clientHeight - 28);
      var scale = Math.min(avail / vp0.width, st.fit ? availH / vp0.height : 99) * (window.devicePixelRatio || 1);
      var vp = pg.getViewport({ scale: scale });
      cv.width = vp.width; cv.height = vp.height; cv.style.width = Math.floor(vp.width / (window.devicePixelRatio || 1)) + "px";
      pg.render({ canvasContext: cv.getContext("2d"), viewport: vp });
    });
  }
  function openViewer(path, name, mime) {
    closeViewer();
    var v = document.createElement("div"); v.id = "dv"; v.className = "dv"; v.setAttribute("role", "dialog"); v.setAttribute("aria-label", "Viewing " + name);
    v.innerHTML = '<div class="dvbar"><span class="ttl">' + esc(name) + '</span><button type="button" class="btn sec sm" data-v="prev" aria-label="Previous page">&larr;</button><span class="pg"></span><button type="button" class="btn sec sm" data-v="next" aria-label="Next page">&rarr;</button><button type="button" class="btn sec sm" data-v="fit">Fit / width</button><button type="button" class="btn sm" data-v="dl">Download</button><button type="button" class="btn sm" data-v="close">Close</button></div><div class="stage"><div class="msg">Opening…</div></div>';
    document.body.appendChild(v);
    document.addEventListener("keydown", viewerKey);
    var isImg = /^image\//.test(mime || ""), stage = v.querySelector(".stage");
    function signed(dl) { return sb.storage.from("materials").createSignedUrl(path, 600, dl ? { download: name } : undefined); }
    v.addEventListener("click", function (e) {
      var b = e.target.closest("[data-v]"); if (!b) return; var a = b.getAttribute("data-v");
      if (a === "close") closeViewer(); else if (a === "prev") viewerGo(-1); else if (a === "next") viewerGo(1);
      else if (a === "fit" && viewerState) { viewerState.fit = !viewerState.fit; viewerDraw(); }
      else if (a === "dl") signed(true).then(function (r) { if (r.data) location.href = r.data.signedUrl; });
    });
    signed(false).then(function (r) {
      if (r.error || !r.data) throw new Error("Could not open that file. Try again.");
      if (isImg) { stage.innerHTML = '<img alt="' + esc(name) + '" src="' + r.data.signedUrl + '" style="max-width:100%;height:auto;background:#fff">'; v.querySelector(".pg").textContent = ""; return null; }
      return loadPdfLib().then(function (lib) { return lib.getDocument({ url: r.data.signedUrl }).promise; }).then(function (doc) {
        viewerState = { doc: doc, page: 1, fit: true, tok: 0 };
        stage.innerHTML = "<canvas></canvas>"; viewerDraw();
        var rs; window.addEventListener("resize", rs = function () { if (!document.getElementById("dv")) return window.removeEventListener("resize", rs); viewerDraw(); });
      });
    }).catch(function (e) { stage.innerHTML = '<div class="msg">' + esc(e.message || "Could not open that file.") + " You can still use Download.</div>"; });
  }
  function viewableCopy(f) {
    if (/pdf|image\//.test(f.mime || "")) return f;
    var base = f.file_name.replace(/\.[^.]+$/, "").toLowerCase();
    return curFiles(f.lesson_id).filter(function (x) { return x.id !== f.id && /pdf/.test(x.mime || "") && x.file_name.replace(/\.[^.]+$/, "").toLowerCase() === base; })[0] || null;
  }
  function openStored(path, name, mime) {
    if (/^(application\/pdf|image\/)/.test(mime || "")) return openViewer(path, name, mime);
    var inline = /^(application\/pdf|image\/|audio\/|video\/)/.test(mime || "");
    var w = window.open("", "_blank");
    sb.storage.from("materials").createSignedUrl(path, 300, inline ? undefined : { download: name }).then(function (r) {
      if (r.error || !r.data) { if (w) w.close(); return toast("Could not open that file. Try again.", true); }
      if (w) { try { w.opener = null; } catch (e) { /* ignore */ } w.location.href = r.data.signedUrl; } else location.href = r.data.signedUrl;
    }, function () { if (w) w.close(); toast("Could not open that file. Try again.", true); });
  }
  function checkFile(file) {
    if (!file || !file.size) { toast("Choose a file from your device first.", true); return null; }
    var ext = (file.name.split(".").pop() || "").toLowerCase(), mime = EXT_MIME[ext];
    if (!mime) { toast("That file type is not supported. Use PowerPoint, PDF, Word, Excel, an image, audio or mp4.", true); return null; }
    if (file.size > MAX_FILE) { toast("That file is over 50 MB. Compress it or share a link instead.", true); return null; }
    return mime;
  }
  function uploadCurFile(lid, d, done) {
    var file = d.file, mime = checkFile(file); if (!mime) return done();
    var path = "kits/" + lid + "/" + uid() + "-" + file.name.replace(/[^\w.\-]+/g, "-");
    toast("Uploading " + file.name + "…");
    var bucket = sb.storage.from("materials");
    bucket.upload(path, file, { contentType: mime, upsert: false }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return sb.from("cur_files").insert({ lesson_id: lid, kind: d.kind, title: d.title || file.name.replace(/\.[^.]+$/, ""), for_student: d.for_student !== "0", file_path: path, file_name: file.name, mime: mime, size_bytes: file.size });
    }).then(function (r) {
      if (r.error) { bucket.remove([path]); throw new Error(r.error.message); }
      toast("File uploaded."); return refresh();
    }).catch(function (e) { toast(e.message || "Upload failed.", true); }).then(done, done);
  }
  function sendKit(lid, d, done) {
    var l = byId(S.cur_lessons, lid), live = d.lesson_id ? byId(S.lessons, d.lesson_id) : null;
    var sid = live ? live.student_id : d.student_id;
    if (!l || !sid) { toast("Choose a lesson or a student to send to.", true); return done(); }
    var bucket = sb.storage.from("materials"), sent = 0, skipped = 0;
    var picks = curFiles(lid).filter(function (f) { return f.for_student && d["f_" + f.id] === "1"; });
    var chain = Promise.resolve();
    if (live) chain = chain.then(function () { return sb.from("lessons").update({ cur_lesson_id: lid, topic: live.topic || l.title }).eq("id", live.id); }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    picks.forEach(function (f) {
      chain = chain.then(function () {
        if (S.materials.some(function (m) { return m.student_id === sid && m.cur_file_id === f.id; })) { skipped++; return null; }
        var dest = sid + "/" + uid() + "-" + f.file_name.replace(/[^\w.\-]+/g, "-");
        return bucket.copy(f.file_path, dest).then(function (r) {
          if (r.error) throw new Error(r.error.message);
          return sb.from("materials").insert({ student_id: sid, lesson_id: live ? live.id : null, cur_file_id: f.id, title: f.title, kind: CKIND_TO_MKIND[f.kind] || "other", file_path: dest, file_name: f.file_name, mime: f.mime, size_bytes: f.size_bytes });
        }).then(function (r) { if (r.error) { bucket.remove([dest]); throw new Error(r.error.message); } sent++; });
      });
    });
    var hw = false;
    if (d.hw === "1" && (d.hw_text || d.hw_title)) {
      chain = chain.then(function () {
        return sb.from("assignments").insert({ student_id: sid, lesson_id: live ? live.id : null, cur_lesson_id: lid, title: d.hw_title || ("Homework: " + l.title), instructions: nul(d.hw_text), due_on: nul(d.hw_due) });
      }).then(function (r) { if (r.error) throw new Error(r.error.message); hw = true; });
    }
    chain.then(function () {
      toast("Sent to " + studentName(sid) + ": " + sent + (sent === 1 ? " file" : " files") + (skipped ? ", " + skipped + " already had" : "") + (hw ? ", homework assigned" : "") + ".");
      return refresh();
    }).catch(function (e) { toast(e.message || "Could not send.", true); return refresh(); }).then(done, done);
  }

  /* ---- schedule */
  function acSchedule() {
    var from = new Date(); from.setHours(0, 0, 0, 0);
    var up = S.lessons.filter(function (l) { return l.status === "scheduled" && new Date(l.starts_at) >= from; }).sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; });
    var nowD = new Date();
    var past = S.lessons.filter(function (l) { return l.status !== "scheduled" || new Date(l.starts_at) < from; }).filter(function (l) { return !(l.status === "scheduled" && new Date(l.starts_at) >= from); }).sort(function (a, b) { return a.starts_at < b.starts_at ? 1 : -1; });
    var pastHtml = past.length ? '<div class="day" style="margin-top:22px">Previous lessons: did she attend?</div>' + past.map(function (l) {
      var cl = l.cur_lesson_id ? byId(S.cur_lessons, l.cur_lesson_id) : null, pending = l.status === "scheduled";
      return '<div class="card" style="margin-bottom:8px"><div class="l1"><span class="t">' + esc(fmtDT(l.starts_at)) + " · " + esc(studentName(l.student_id)) + '</span><span class="pills"><span class="pill ' + (l.status === "completed" ? "ok" : pending ? "warn" : "") + '">' + (pending ? "Not marked yet" : l.status === "completed" ? "Attended" : esc(LSTATUS[l.status])) + "</span></span></div>" +
        '<span class="hint">' + (cl ? "Plan: " + esc(lessonNo(cl) + ". " + cl.title) : "No plan lesson linked") + (l.topic ? " · " + esc(l.topic) : "") + "</span>" +
        '<div class="fields"><div class="f"><label for="at' + l.id + '">Attendance</label><select id="at' + l.id + '" data-change="attend" data-id="' + l.id + '">' + opt(Object.keys(LSTATUS), l.status, LSTATUS) + "</select></div>" +
        '<div class="f"><label for="lc' + l.id + '">Lesson in the plan</label><select id="lc' + l.id + '" data-change="lcur" data-id="' + l.id + '">' + curOptions(l.cur_lesson_id) + "</select></div></div></div>";
    }).join("") : "";
    if (!up.length) return '<div class="empty"><b>No upcoming lessons</b>Schedule lessons from a student\'s profile, then link each one to a lesson in the plan here.</div>' + pastHtml;
    var out = "", last = "";
    up.forEach(function (l) {
      var k = dayKey(l.starts_at), cl = l.cur_lesson_id ? byId(S.cur_lessons, l.cur_lesson_id) : null;
      if (k !== last) { out += '<div class="day">' + esc(fmtDay(l.starts_at)) + "</div>"; last = k; }
      out += '<div class="card" style="margin-bottom:8px"><div class="l1"><span class="t">' + esc(fmtTime(l.starts_at)) + " · " + esc(studentName(l.student_id)) + '</span><span class="pills">' +
        (cl ? '<span class="pill ' + (cl.status === "ready" ? "ok" : "warn") + '">' + esc(CSTATUS[cl.status]) + "</span><span class=\"pill\">" + curFiles(cl.id).length + " files</span>" : '<span class="pill warn">No plan linked</span>') + "</span></div>" +
        '<div class="fields"><div class="f"><label for="lc' + l.id + '">Lesson in the plan</label><select id="lc' + l.id + '" data-change="lcur" data-id="' + l.id + '">' + curOptions(l.cur_lesson_id) + "</select></div></div>" +
        (cl ? '<div class="acts"><button type="button" class="btn sec sm" data-act="aclesson" data-id="' + cl.id + '">Open lesson kit</button></div>' : "") + "</div>";
    });
    return out + pastHtml;
  }

  /* ---- homework */
  function hwCard(a) {
    var s = byId(S.students, a.student_id);
    var sub = a.status === "assigned" ? '<p class="hint">Waiting for ' + esc(s ? s.full_name.split(" ")[0] : "the student") + " to submit.</p>" :
      (a.sub_text ? '<div class="receipt">' + esc(a.sub_text) + "</div>" : "") + (a.sub_path ? '<div class="acts"><button type="button" class="btn sec sm" data-act="opensub" data-id="' + a.id + '">Open submitted file: ' + esc(a.sub_name) + "</button></div>" : "") +
      '<form data-form="hwfeedback" data-id="' + a.id + '"><div class="f"><label for="fb' + a.id + '">Your feedback to the student</label><textarea id="fb' + a.id + '" name="feedback" required>' + esc(a.feedback) + '</textarea></div><div class="acts" style="margin-top:8px"><button class="btn sm" type="submit">' + (a.status === "reviewed" ? "Update feedback" : "Send feedback") + "</button></div></form>";
    return '<div class="card"><div class="l1"><span class="t">' + esc(a.title) + '</span><span class="pills"><span class="pill ' + (a.status === "reviewed" ? "ok" : a.status === "submitted" ? "warn" : "") + '">' + (a.status === "reviewed" ? "Reviewed" : a.status === "submitted" ? "To review" : "Assigned") + "</span>" + (a.due_on ? '<span class="pill">Due ' + esc(a.due_on) + "</span>" : "") + "</span></div>" +
      '<span class="hint"><a href="#/students/' + a.student_id + '">' + esc(studentName(a.student_id)) + "</a>" + (a.submitted_at ? " · submitted " + esc(a.submitted_at.slice(0, 10)) : "") + "</span>" +
      (a.instructions ? "<p>" + esc(a.instructions) + "</p>" : "") + sub +
      '<div class="acts"><button type="button" class="btn danger sm" data-act="delhw" data-id="' + a.id + '">Delete</button></div></div>';
  }
  function acHomework() {
    var by = function (st) { return S.assignments.filter(function (a) { return a.status === st; }); };
    var sec = function (title, list, empty) { return '<div class="sec"><h3>' + title + '</h3><div class="cards">' + (list.map(hwCard).join("") || '<p class="hint">' + empty + "</p>") + "</div></div>"; };
    var students = S.students.filter(function (s) { return s.status !== "inactive" && s.status !== "completed"; });
    return '<div class="panel">' + sec("To review", by("submitted"), "Nothing waiting for your feedback.") + sec("Waiting for the student", by("assigned"), "No open homework.") + sec("Reviewed", by("reviewed").slice(0, 15), "Nothing reviewed yet.") +
      '<div class="sec"><h3>Assign your own homework</h3><form data-form="newhw" class="addbox"><div class="fields"><div class="f"><label for="nh1">Student</label><select id="nh1" name="student_id" required><option value="">Choose</option>' + students.map(function (s) { return '<option value="' + s.id + '">' + esc(s.full_name) + "</option>"; }).join("") + "</select></div>" +
      '<div class="f"><label for="nh2">Title</label><input id="nh2" name="title" required></div><div class="f"><label for="nh3">Due date</label><input id="nh3" name="due_on" type="date"></div>' +
      '<div class="f wide"><label for="nh4">Instructions</label><textarea id="nh4" name="instructions"></textarea></div></div><div class="acts"><button class="btn" type="submit">Assign</button></div></form></div></div>';
  }

  /* ---- feedback checkpoints */
  function acFeedback() {
    var items = checkpointItems();
    if (!items.length) return '<div class="empty"><b>No active students yet</b>After lessons 1 and 4 and the last lesson of a package, a short report is due here.</div>';
    var names = {}; items.forEach(function (x) { names[x.s.id] = x.s; });
    return '<div class="panel"><p class="hint">A short progress report is due after lesson 1, after lesson 4 and after the last lesson. Students see a report only when you publish it.</p>' + Object.keys(names).map(function (sid) {
      var s = names[sid], mine = items.filter(function (x) { return x.s.id === sid; });
      return '<div class="sec"><h3>' + esc(s.full_name) + "</h3><div class=\"cards\">" + mine.map(function (x) {
        var state = x.rep ? (x.rep.published ? '<span class="pill ok">Published</span>' : '<span class="pill warn">Draft</span>') : x.due ? '<span class="pill warn">Due now</span>' : '<span class="pill">Not yet (' + x.used + " of " + x.need + " lessons)</span>";
        var btn = x.rep ? '<button type="button" class="btn sec sm" data-act="editreport" data-id="' + x.rep.id + '">Open</button>' : x.due ? '<button type="button" class="btn sm" data-act="newcp" data-id="' + x.s.id + '" data-v="' + x.cp + '">Write it</button>' : "";
        return '<div class="card"><div class="l1"><span class="t">' + esc(CHECKPOINTS[x.cp]) + '</span><span class="pills">' + state + "</span></div>" + (btn ? '<div class="acts">' + btn + "</div>" : "") + "</div>";
      }).join("") + "</div></div>";
    }).join("") + "</div>";
  }
  function newCheckpoint(sid, cp) {
    var s = byId(S.students, sid); if (!s) return;
    var row = { student_id: sid, kind: cp === "final" ? "final" : "progress", checkpoint: cp, title: CHECKPOINTS[cp], cefr: s.cefr || null, goals: "", summary: "", assessed_by: "CLEAR Academic Team", skills: [], recommendations: [], objectives: [], plan: [], published: false };
    act(sb.from("reports").insert(row).select().single(), "Draft created.").then(function (r) { return loadAll().then(function () { location.hash = "#/report/" + r.id + "/edit"; }); });
  }


  /* ---- bulk import: pick files, they are matched by file name to a lesson, kind and audience */
  var T_ = "Titles of audio come from the audioscripts in the Teacher's Notes, not from listening.";
  var IMPORT_MAP = [
    { re: /^CLEAR_A1-1_L01_Slides\.pptx$/i, lesson: "A1.1:1", kind: "slides", title: "Lesson 1 class slides (17)", student: true },
    { re: /^CLEAR_A1-1_L01_Slides\.pdf$/i, lesson: "A1.1:1", kind: "slides", title: "Lesson 1 class slides (view online)", student: true },
    { re: /^CLEAR_A1-1_L01_Handout\.pdf$/i, lesson: "A1.1:1", kind: "handout", title: "Lesson 1 handout", student: true },
    { re: /^CLEAR_A1-1_L01_Homework\.pdf$/i, lesson: "A1.1:1", kind: "homework", title: "Lesson 1 homework sheet", student: true },
    { re: /^CLEAR_A1-1_L01_Teacher_Pack\.pdf$/i, lesson: "A1.1:1", kind: "notes", title: "Lesson 1 Teacher Pack (private)", student: false },
    { re: /^CLEAR_A1-1_L01_Navigate_pages_TEACHER_ONLY\.pdf$/i, lesson: "A1.1:1", kind: "other", title: "Navigate Coursebook pages 6-7 and 30-31 (screen-share only)", student: false },
    { re: /^CLEAR_A1-1_L02_Slides\.pptx$/i, lesson: "A1.1:2", kind: "slides", title: "Lesson 2 class slides (18)", student: true },
    { re: /^CLEAR_A1-1_L02_Slides\.pdf$/i, lesson: "A1.1:2", kind: "slides", title: "Lesson 2 class slides (view online)", student: true },
    { re: /^CLEAR_A1-1_L02_Handout\.pdf$/i, lesson: "A1.1:2", kind: "handout", title: "Lesson 2 handout", student: true },
    { re: /^CLEAR_A1-1_L02_Homework\.pdf$/i, lesson: "A1.1:2", kind: "homework", title: "Lesson 2 homework: school form and voice note", student: true },
    { re: /^CLEAR_A1-1_L02_Teacher_Pack\.pdf$/i, lesson: "A1.1:2", kind: "notes", title: "Lesson 2 Teacher Pack (private)", student: false },
    { re: /^CLEAR_A1-1_L02_Navigate_pages_TEACHER_ONLY\.pdf$/i, lesson: "A1.1:2", kind: "other", title: "Navigate Coursebook pages 8-11 (screen-share only)", student: false },
    { re: /^Track_01_(09|1[0-9]|2[0-6])\.mp3$/i, lesson: "A1.1:2", kind: "audio", title: "Navigate audio unit 1.2 / 1.3 (track number as on your CD)", student: false },
    { re: /^CLEAR_A1-1_L02_Phone_call_natural\.mp3$/i, lesson: "A1.1:2", kind: "audio", title: "Lesson 2 audio: the phone call (natural speed)", student: true },
    { re: /^CLEAR_A1-1_L02_Phone_call_slow\.mp3$/i, lesson: "A1.1:2", kind: "audio", title: "Lesson 2 audio: the phone call (slow)", student: true },
    { re: /^CLEAR_A1-1_L02_Phone_call_repeat_after_Mona\.mp3$/i, lesson: "A1.1:2", kind: "audio", title: "Lesson 2 audio: repeat after Mona (pauses)", student: true },
    { re: /^CLEAR_A1-1_L03_Slides\.pptx$/i, lesson: "A1.1:3", kind: "slides", title: "Lesson 3 class slides (20)", student: true },
    { re: /^CLEAR_A1-1_L03_Slides\.pdf$/i, lesson: "A1.1:3", kind: "slides", title: "Lesson 3 class slides (view online)", student: true },
    { re: /^CLEAR_A1-1_L03_Handout\.pdf$/i, lesson: "A1.1:3", kind: "handout", title: "Lesson 3 handout", student: true },
    { re: /^CLEAR_A1-1_L03_Homework\.pdf$/i, lesson: "A1.1:3", kind: "homework", title: "Lesson 3 homework: your child's bag", student: true },
    { re: /^CLEAR_A1-1_L03_Teacher_Pack\.pdf$/i, lesson: "A1.1:3", kind: "notes", title: "Lesson 3 Teacher Pack (private)", student: false },
    { re: /^CLEAR_A1-1_L03_Navigate_pages_TEACHER_ONLY\.pdf$/i, lesson: "A1.1:3", kind: "other", title: "Navigate Coursebook pages 16-17 (screen-share only)", student: false },
    { re: /^CLEAR_A1-1_L03_School_list\.mp3$/i, lesson: "A1.1:3", kind: "audio", title: "Lesson 3 audio: the school list", student: true },
    { re: /^CLEAR_A1-1_L03_Shop_dialogue_natural\.mp3$/i, lesson: "A1.1:3", kind: "audio", title: "Lesson 3 audio: the school shop (natural)", student: true },
    { re: /^CLEAR_A1-1_L03_Shop_dialogue_slow\.mp3$/i, lesson: "A1.1:3", kind: "audio", title: "Lesson 3 audio: the school shop (slow)", student: true },
    { re: /^CLEAR_A1-1_L03_Numbers_listening\.mp3$/i, lesson: "A1.1:3", kind: "audio", title: "Lesson 3 audio: listen and write the numbers", student: true },
    { re: /^Track_02_0[1-9]\.mp3$/i, lesson: "A1.1:3", kind: "audio", title: "Navigate audio unit 2.1 (track number as on your CD)", student: false },
    { re: /^CLEAR_A1-1_L04_Slides\.pptx$/i, lesson: "A1.1:4", kind: "slides", title: "Lesson 4 class slides (22)", student: true },
    { re: /^CLEAR_A1-1_L04_Slides\.pdf$/i, lesson: "A1.1:4", kind: "slides", title: "Lesson 4 class slides (view online)", student: true },
    { re: /^CLEAR_A1-1_L04_Handout\.pdf$/i, lesson: "A1.1:4", kind: "handout", title: "Lesson 4 handout", student: true },
    { re: /^CLEAR_A1-1_L04_Homework\.pdf$/i, lesson: "A1.1:4", kind: "homework", title: "Lesson 4 homework: questions and answers for the 10 characters", student: true },
    { re: /^CLEAR_A1-1_L04_Teacher_Pack\.pdf$/i, lesson: "A1.1:4", kind: "notes", title: "Lesson 4 Teacher Pack (private)", student: false },
    { re: /^CLEAR_A1-1_L04_Navigate_pages_TEACHER_ONLY\.pdf$/i, lesson: "A1.1:4", kind: "other", title: "Navigate Coursebook pages 18-21 (screen-share only)", student: false },
    { re: /^CLEAR_A1-1_L04_School_tour\.mp3$/i, lesson: "A1.1:4", kind: "audio", title: "Lesson 4 audio: the school tour", student: true },
    { re: /^CLEAR_A1-1_L04_Phone_call_natural\.mp3$/i, lesson: "A1.1:4", kind: "audio", title: "Lesson 4 audio: phone call to school (natural)", student: true },
    { re: /^CLEAR_A1-1_L04_Phone_call_slow\.mp3$/i, lesson: "A1.1:4", kind: "audio", title: "Lesson 4 audio: phone call to school (slow)", student: true },
    { re: /^Track_02_1[3-9]\.mp3$/i, lesson: "A1.1:4", kind: "audio", title: "Navigate audio units 2.2-2.3 (track number as on your CD)", student: false },
    { re: /^CLEAR_A1-1_L05_Slides\.pptx$/i, lesson: "A1.1:5", kind: "slides", title: "Lesson 5 class slides (23)", student: true },
    { re: /^CLEAR_A1-1_L05_Slides\.pdf$/i, lesson: "A1.1:5", kind: "slides", title: "Lesson 5 class slides (view online)", student: true },
    { re: /^CLEAR_A1-1_L05_Handout\.pdf$/i, lesson: "A1.1:5", kind: "handout", title: "Lesson 5 handout", student: true },
    { re: /^CLEAR_A1-1_L05_Homework\.pdf$/i, lesson: "A1.1:5", kind: "homework", title: "Lesson 5 homework: my questions for the teacher", student: true },
    { re: /^CLEAR_A1-1_L05_Teacher_Pack\.pdf$/i, lesson: "A1.1:5", kind: "notes", title: "Lesson 5 Teacher Pack (private)", student: false },
    { re: /^CLEAR_A1-1_L05_Meeting_questions_natural\.mp3$/i, lesson: "A1.1:5", kind: "audio", title: "Lesson 5 audio: parent asks the teacher (natural)", student: true },
    { re: /^CLEAR_A1-1_L05_Meeting_questions_slow\.mp3$/i, lesson: "A1.1:5", kind: "audio", title: "Lesson 5 audio: parent asks the teacher (slow)", student: true },
    { re: /^CLEAR_A1-1_L05_Teacher_report\.mp3$/i, lesson: "A1.1:5", kind: "audio", title: "Lesson 5 audio: the teacher's report on Adam", student: true },
    { re: /^CLEAR_A1-1_L06_Slides\.pptx$/i, lesson: "A1.1:6", kind: "slides", title: "Lesson 6 class slides (21)", student: true },
    { re: /^CLEAR_A1-1_L06_Slides\.pdf$/i, lesson: "A1.1:6", kind: "slides", title: "Lesson 6 class slides (view online)", student: true },
    { re: /^CLEAR_A1-1_L06_Handout\.pdf$/i, lesson: "A1.1:6", kind: "handout", title: "Lesson 6 handout", student: true },
    { re: /^CLEAR_A1-1_L06_Meeting_card\.pdf$/i, lesson: "A1.1:6", kind: "handout", title: "Dina's Meeting Card (for Sunday 1 November)", student: true },
    { re: /^CLEAR_A1-1_L06_Homework\.pdf$/i, lesson: "A1.1:6", kind: "homework", title: "Lesson 6 homework: before Sunday's meeting", student: true },
    { re: /^CLEAR_A1-1_L06_Teacher_Pack\.pdf$/i, lesson: "A1.1:6", kind: "notes", title: "Lesson 6 Teacher Pack (private)", student: false },
    { re: /^CLEAR_A1-1_L06_My_child_model\.mp3$/i, lesson: "A1.1:6", kind: "audio", title: "Lesson 6 audio: a mum describes her child", student: true },
    { re: /^CLEAR_A1-1_L06_Tricky_teacher\.mp3$/i, lesson: "A1.1:6", kind: "audio", title: "Lesson 6 audio: a fast teacher", student: true },
    { re: /^CLEAR_A1-1_L06_Full_meeting_natural\.mp3$/i, lesson: "A1.1:6", kind: "audio", title: "Lesson 6 audio: the full meeting (natural)", student: true },
    { re: /^CLEAR_A1-1_L06_Full_meeting_slow\.mp3$/i, lesson: "A1.1:6", kind: "audio", title: "Lesson 6 audio: the full meeting (slow)", student: true },
    { re: /^CLEAR_A1_Division_and_Navigate_map\.pdf$/i, lesson: "A1.1:1", kind: "notes", title: "A1 division (3 levels, 24 lessons) and Navigate content map", student: false },
    { re: /^Track_01_02\.mp3$/i, lesson: "A1.1:1", kind: "audio", title: "Navigate track 1.2: Hello conversation, listen for stress", student: false },
    { re: /^Track_01_03\.mp3$/i, lesson: "A1.1:1", kind: "audio", title: "Navigate track 1.3: repeat the conversation", student: false },
    { re: /^Track_01_04\.mp3$/i, lesson: "A1.1:1", kind: "audio", title: "Navigate track 1.4: exercise 4 listening", student: false },
    { re: /^Track_01_05\.mp3$/i, lesson: "A1.1:1", kind: "audio", title: "Navigate track 1.5: Havva and Paul", student: false },
    { re: /^Track_01_06\.mp3$/i, lesson: "A1.1:1", kind: "audio", title: "Navigate track 1.6: check and repeat Havva and Paul", student: false },
    { re: /^Track_01_07\.mp3$/i, lesson: "A1.1:1", kind: "audio", title: "Navigate track 1.7: Sunil and Julie (be)", student: false },
    { re: /^Track_01_08\.mp3$/i, lesson: "A1.1:1", kind: "audio", title: "Navigate track 1.8: statements or questions", student: false },
  ];
  var IMPORT_LESSON_1 = { title: "Hello! This is my family",
    objective: "Greet and introduce yourself and your children; exchange basic information (name, age, where you are from, how many children) with a teacher.",
    grammar: "I'm / my name is; I live in; I've got + number + noun (as a chunk); he's / she's + number; his / her name is; How old...? What's...? Where...? Have you got...?",
    vocabulary: "hello, name, from, live, numbers 1-11, son, daughter, boy, girl, mum, children, school, teacher, family, baby, parent",
    navigate_ref: "1.1 (Coursebook pp 6-7); 3.3 family (pp 30-31), reference only",
    plan: "Warm-up chat > Exposure: Meet Mona (listen or read, true or false) > Test 1 > Clarify have got, age, his / her (Meaning, Pronunciation, Form with CCQs) > Controlled practice > Freer 1 school office role-play, Freer 2 information gap, Freer 3 six sentences with no frame > Delayed error correction > Today I can... and confidence rating. 17 slides with staged speaker notes and timings.",
    homework: "Write five sentences about your family and send them before Thursday. A voice note is a bonus.",
    teacher_notes: "Full Teacher Pack has aims, MPF, key, role cards, observation and error-correction sheets, Arabic L1 error table and source checks. Not yet verified against the Oxford 3000 or English Grammar Profile: parent, baby, Ms, mum. " + T_ };
  var IMPORT_LESSON_2 = { title: "Spell it, say it",
    objective: "Give your name (spelled), your country and a phone number to a school office, and ask for the same details.",
    grammar: "What's your name? How do you spell that? Where are you from? What's your phone number? I'm / We're from...; Are you from...? Yes, I am. / No, I'm not.; It's + numbers; double",
    vocabulary: "alphabet, letter, capital, small, first name, last name, phone number, country, numbers 0-10, oh, double, Egypt, Bahrain, Jordan, India, Pakistan, school, office",
    navigate_ref: "1.2 Where are you from? (pp 8-9); 1.3 How do you spell that? (pp 10-11), reference only",
    plan: "Warm-up and lesson 1 retrieval > Exposure: a phone call to a school office > Test 1 (spell, number, country) > Clarify alphabet in seven sound groups, phone numbers (oh, double), Where are you from? > Controlled practice (which letter, write what you hear) > Freer 1 phone call, Freer 2 fill in the form, Freer 3 register a child with no frame > Delayed error correction > Today I can... 18 slides with staged speaker notes and timings.",
    homework: "Fill in the school form and send a 30-second voice note: spell your first and last name and say a phone number. Send before Monday.",
    teacher_notes: "Draft built before the lesson 1 report; adjust after it. Not verified against the Oxford 3000 or English Grammar Profile: capital, double, office. Navigate track numbers were read from the book page; check them on your CD." };
  var IMPORT_LESSON_3 = { title: "In the school bag",
    objective: "Name school things, ask what things are, and ask the price in a shop.",
    grammar: "a / an; plural -s (/s/ /z/ /iz/); this / that / these / those; What's...? What are...? Who's...?; It's / They're; numbers 11-100; How much is / are...?",
    vocabulary: "school bag, book, notebook, pen, pencil, ruler, calculator, lunch box, apple, umbrella, laptop, tablet, numbers 11-100, dinar",
    navigate_ref: "2.1 What's this in English? (pp 16-17), reference only",
    plan: "Warm-up (homework check 3 min) > Exposure: a note from school > Test 1: name 8 school things > Clarify: 12 words and a/an, plural -s sounds; this/that/these/those; numbers 11-100 (-teen / -ty); How much is/are...? > Controlled practice: ask and answer, listen and write numbers > Freer 1 school shop, Freer 2 price list information gap, Freer 3 real objects, five sentences > Delayed error correction > Today I can... 20 slides with timings.",
    homework: "Photo of your child's bag things with 10 labels; a 30-second voice note (this/these/that/those); bonus: say five prices.",
    teacher_notes: "Built after feedback that lesson 2 added too little: at least 80% new language, value table in the Teacher Pack. Not verified against Oxford 3000 / EGP: calculator, lunch box, ruler, school bag, dinar. Audio is synthetic (Kokoro, Apache 2.0)." };
  var IMPORT_LESSON_4 = { title: "Who's who?",
    objective: "Ask and answer about a person (name, age, country, nationality, language, job, city) and introduce people with he / she / they.",
    grammar: "he / she / they + is / are; isn't / aren't; Is / Are...? and short answers; What / Where / How old / What languages...?; my, your, his, her, our, their",
    vocabulary: "16 jobs (teacher, headteacher, doctor, nurse, engineer, accountant, journalist, bus driver, taxi driver, receptionist, cleaner, security guard, shop assistant, waiter, chef, manager) + housewife, dancer, musician, professor, school student, soccer player; countries, nationalities and languages (France / French / French...)",
    navigate_ref: "2.2 What's your job? (pp 18-19) and 2.3 Where are they? (pp 20-21), reference only",
    plan: "Warm-up + homework check > 16 jobs and staff board > Test 1: country / nationality / language > Ten characters (model) > Question words > he / she / they, negatives, questions > my / your / his / her > Introducing a person > Say it > Task A info gap > Task B guess the job > Task C find the errors > Task E my five people > Fix it > Recap. Session 1 stopped at slide 14; next: slide 9 homework check, then slides 15-22.",
    homework: "Write questions and answers for the ten characters on slide 9 (at least 3 each); optional 30-second voice note about three people you know.",
    teacher_notes: "Updated to the teacher's edited 22-slide deck: the phone-call box, Task D and Task F were removed (the phone goal moves to a later lesson). Not verified against Oxford 3000 / EGP: housewife, professor, soccer player, headteacher, accountant, receptionist, security guard. Slide 9 cartoons are not original: check their licence. Audio is synthetic (Kokoro, Apache 2.0)." };
  var IMPORT_LESSON_5 = { title: "Ask like a pro (meeting preparation 1)",
    objective: "Build correct questions for a parent-teacher meeting (is / does / can / wh-), ask about progress, homework, behaviour and help, and repair the conversation politely.",
    grammar: "question machine (wh- word + helper + person + verb); is / are, do / does (no -s), can / could; short answers; repair and check phrases",
    vocabulary: "24 school words (subjects, school things, skills, school life) and 20 progress words (good at, improve, polite, shy, confident, concentrate, participate, progress, behaviour, effort)",
    navigate_ref: "Off-course lesson (A1+ / A2): no Navigate pages",
    plan: "Warm-up + homework check (10 characters) > Roadmap to Sunday 1 November > Test 1: make the question > Exposure: parent asks the teacher > Clarify: question machine, is/are, do/does, can/could > Vocabulary: school and progress words > Functional: start and ask; repair and check > Say it > Task A question builder > Task B interview the teacher > Task C find and fix > Task D my 10 questions > Task E one-minute mini-meeting > Fix it > Recap. Dina speaks about 33 of 60 minutes.",
    homework: "Finish and record 10 questions for the meeting; write 3 questions about a subject you worry about; learn 6 phrases.",
    teacher_notes: "Off-course lesson for the meeting on Sunday 1 November: present-simple questions brought forward because the goal needs them. Built after the note that she has difficulty framing questions and sentence structure but good vocabulary. Not verified against Oxford 3000 / EGP: timetable, headteacher, behaviour, attention, concentrate, participate, progress, effort. Audio is synthetic (Kokoro, Apache 2.0). The earlier 'Describe it!' kit (adjectives, have got) is parked for a later lesson." };
  var IMPORT_LESSON_6 = { title: "Speak with confidence (meeting preparation 2)",
    objective: "Describe a child (strengths and a concern) with correct he / she -s and doesn't, follow a six-step meeting map, repair when the teacher is fast, and rehearse the full meeting.",
    grammar: "he / she + verb -s; doesn't / don't + verb; the 'but' pattern; good at / not very good at / finds ... difficult; I'm happy with / I'm a little worried about; I'd like to (chunk); polite opening and closing",
    vocabulary: "clever, hard-working, creative, active, curious, shy, polite, confident, quiet, kind, spelling, grammar, reading aloud, confidence, progress, concentrate, participate",
    navigate_ref: "Off-course lesson (A1+ / A2): no Navigate pages",
    plan: "Warm-up + homework check (her 10 questions) > Test 1: one-minute monologue about her child > Exposure: a mum describes Lina > Clarify: he/she -s, doesn't and 'but', strengths and concerns > Vocabulary: 20 words for a child > Functional: opening and closing; the 6-step meeting map > Say it > Task A sentence builder > Task B describe the child again (after numbers) > Task C fast teacher and repair > Task D full meeting 1 > Task E full meeting 2 with surprises > Fix it > Recap and the Meeting Card. Task F (thank-you message) is homework. Dina speaks about 36 of 60 minutes.",
    homework: "Read the Meeting Card twice a day; write 3 opening sentences; record a 2-minute rehearsal on Friday; finish the thank-you message; message me after the meeting.",
    teacher_notes: "Off-course lesson 2 of 2 before the parent-teacher meeting on Sunday 1 November; ends with her Meeting Card. Present simple and 'but' brought forward from A1.2. Not verified against Oxford 3000 / EGP: creative, curious, hard-working, worried, advice, participate. Audio is synthetic (Kokoro, Apache 2.0); listen before use." };
  function importPlan(files) {
    return Array.prototype.map.call(files, function (f) {
      var m = IMPORT_MAP.filter(function (x) { return x.re.test(f.name); })[0] || null;
      var code = m ? m.lesson.split(":")[0] : "", num = m ? Number(m.lesson.split(":")[1]) : 0;
      var lv = m ? S.cur_levels.filter(function (x) { return x.code === code; })[0] : null;
      var les = lv ? S.cur_lessons.filter(function (x) { return x.level_id === lv.id && x.number === num; })[0] : null;
      var dup = les && S.cur_files.some(function (x) { return x.lesson_id === les.id && x.file_name === f.name; });
      return { file: f, m: m, les: les, dup: !!dup };
    });
  }
  function acImport() {
    var done = S.cur_files.length;
    return '<div class="panel"><div class="sec"><h3>Import files</h3>' +
      '<p class="hint">Select the Session 1 kit and the audio tracks together (you can pick many files at once). Each file is matched by its name to the right lesson. Audio and the book pages are saved as teacher-only; slides, handout and homework are shareable with the student. Files already in a lesson are skipped. ' + esc(T_) + "</p>" +
      '<form data-form="importkit" class="addbox"><div class="fields"><div class="f wide"><label for="imf">Files from your device</label><input id="imf" name="files" type="file" multiple accept="' + FILE_ACCEPT + '" data-change="importpick"><span class="hint">Each up to 50 MB. ' + done + ' files stored so far.</span></div></div>' +
      '<div id="impplan" class="cards"></div>' +
      '<label class="chk" style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" name="fill1" value="1" checked> Also fill in lesson A1.1 number 1 with the Session 1 plan (title, aims, grammar, words, plan, homework)</label>' +
      '<label class="chk" style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" name="fill2" value="1" checked> Also fill in lesson A1.1 number 2 with the Session 2 plan</label>' +
      '<label class="chk" style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" name="fill3" value="1" checked> Also fill in lesson A1.1 number 3 with the Session 3 plan</label>' +
      '<label class="chk" style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" name="fill4" value="1" checked> Also fill in lesson A1.1 number 4 with the Session 4 plan</label>' +
      '<label class="chk" style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" name="fill5" value="1" checked> Also fill in lesson A1.1 number 5 with the Session 5 plan</label>' +
      '<label class="chk" style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" name="fill6" value="1" checked> Also fill in lesson A1.1 number 6 with the Session 6 plan</label>' +
      '<div class="acts"><button class="btn" type="submit">Upload the matched files</button></div></form></div></div>';
  }
  function importPick(t) {
    var box = document.getElementById("impplan"); if (!box) return;
    box.innerHTML = importPlan(t.files).map(function (x) {
      var st = !x.m ? '<span class="pill warn">Not recognised, will be skipped</span>' : !x.les ? '<span class="pill warn">Lesson not found</span>' : x.dup ? '<span class="pill">Already there</span>' : '<span class="pill ok">' + esc(x.m.lesson.replace(":", " #")) + " · " + (x.m.student ? "student can get it" : "teacher only") + "</span>";
      return '<div class="card"><div class="l1"><span class="t">' + esc(x.file.name) + '</span><span class="pills">' + st + "</span></div>" + (x.m ? '<span class="hint">' + esc(x.m.title) + "</span>" : "") + "</div>";
    }).join("");
  }
  function importKit(done) {
    var inp = document.getElementById("imf"), fill = document.querySelector('[data-form="importkit"] [name="fill1"]');
    var todo = inp ? importPlan(inp.files).filter(function (x) { return x.m && x.les && !x.dup; }) : [];
    var fillOn = fill && fill.checked, l1 = S.cur_levels.filter(function (x) { return x.code === "A1.1"; })[0];
    var lesson1 = l1 ? S.cur_lessons.filter(function (x) { return x.level_id === l1.id && x.number === 1; })[0] : null;
    var fill2 = document.querySelector('[data-form="importkit"] [name="fill2"]'), fill2On = fill2 && fill2.checked;
    var lesson2 = l1 ? S.cur_lessons.filter(function (x) { return x.level_id === l1.id && x.number === 2; })[0] : null;
    var fill3 = document.querySelector('[data-form="importkit"] [name="fill3"]'), fill3On = fill3 && fill3.checked;
    var lesson3 = l1 ? S.cur_lessons.filter(function (x) { return x.level_id === l1.id && x.number === 3; })[0] : null;
    var fill4 = document.querySelector('[data-form="importkit"] [name="fill4"]'), fill4On = fill4 && fill4.checked;
    var lesson4 = l1 ? S.cur_lessons.filter(function (x) { return x.level_id === l1.id && x.number === 4; })[0] : null;
    var fill5 = document.querySelector('[data-form="importkit"] [name="fill5"]'), fill5On = fill5 && fill5.checked;
    var lesson5 = l1 ? S.cur_lessons.filter(function (x) { return x.level_id === l1.id && x.number === 5; })[0] : null;
    var fill6 = document.querySelector('[data-form="importkit"] [name="fill6"]'), fill6On = fill6 && fill6.checked;
    var lesson6 = l1 ? S.cur_lessons.filter(function (x) { return x.level_id === l1.id && x.number === 6; })[0] : null;
    if (!todo.length && !(fillOn && lesson1) && !(fill2On && lesson2) && !(fill3On && lesson3) && !(fill4On && lesson4) && !(fill5On && lesson5) && !(fill6On && lesson6)) { toast("Choose files first, or tick the lesson 1 box.", true); return done(); }
    var bucket = sb.storage.from("materials"), ok = 0, fail = 0, chain = Promise.resolve();
    todo.forEach(function (x) {
      chain = chain.then(function () {
        var mime = checkFile(x.file); if (!mime) { fail++; return null; }
        var path = "kits/" + x.les.id + "/" + uid() + "-" + x.file.name.replace(/[^\w.\-]+/g, "-");
        toast("Uploading " + x.file.name + "…");
        return bucket.upload(path, x.file, { contentType: mime, upsert: false }).then(function (r) {
          if (r.error) throw new Error(r.error.message);
          return sb.from("cur_files").insert({ lesson_id: x.les.id, kind: x.m.kind, title: x.m.title, for_student: x.m.student, file_path: path, file_name: x.file.name, mime: mime, size_bytes: x.file.size });
        }).then(function (r) { if (r.error) { bucket.remove([path]); throw new Error(r.error.message); } ok++; }).catch(function (e) { fail++; toast(x.file.name + ": " + (e.message || "failed"), true); });
      });
    });
    if (fillOn && lesson1) chain = chain.then(function () {
      var p = Object.assign({}, IMPORT_LESSON_1, { status: "ready", updated_at: new Date().toISOString() });
      return sb.from("cur_lessons").update(p).eq("id", lesson1.id).then(function (r) { if (r.error) toast(r.error.message, true); });
    });
    if (fill2On && lesson2) chain = chain.then(function () {
      var p = Object.assign({}, IMPORT_LESSON_2, { status: "ready", updated_at: new Date().toISOString() });
      return sb.from("cur_lessons").update(p).eq("id", lesson2.id).then(function (r) { if (r.error) toast(r.error.message, true); });
    });
    if (fill3On && lesson3) chain = chain.then(function () {
      var p = Object.assign({}, IMPORT_LESSON_3, { status: "ready", updated_at: new Date().toISOString() });
      return sb.from("cur_lessons").update(p).eq("id", lesson3.id).then(function (r) { if (r.error) toast(r.error.message, true); });
    });
    if (fill4On && lesson4) chain = chain.then(function () {
      var p = Object.assign({}, IMPORT_LESSON_4, { status: "ready", updated_at: new Date().toISOString() });
      return sb.from("cur_lessons").update(p).eq("id", lesson4.id).then(function (r) { if (r.error) toast(r.error.message, true); });
    });
    if (fill5On && lesson5) chain = chain.then(function () {
      var p = Object.assign({}, IMPORT_LESSON_5, { status: "ready", updated_at: new Date().toISOString() });
      return sb.from("cur_lessons").update(p).eq("id", lesson5.id).then(function (r) { if (r.error) toast(r.error.message, true); });
    });
    if (fill6On && lesson6) chain = chain.then(function () {
      var p = Object.assign({}, IMPORT_LESSON_6, { status: "ready", updated_at: new Date().toISOString() });
      return sb.from("cur_lessons").update(p).eq("id", lesson6.id).then(function (r) { if (r.error) toast(r.error.message, true); });
    });
    chain.then(function () { toast(ok + " uploaded" + (fail ? ", " + fail + " failed" : "") + "."); return refresh(); }).then(done, done);
  }

  /* ---- sources */
  function acSources() {
    var rows = S.cur_sources.map(function (x) {
      return '<div class="card"><div class="l1"><span class="t">' + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + "</a>" : esc(x.title)) + '</span><span class="pills"><span class="pill">' + esc(SRC_KINDS[x.kind] || x.kind) + '</span><span class="pill ' + (x.checked === "from_memory" ? "warn" : "ok") + '">' + esc(SRC_CHECKED[x.checked]) + (x.checked_on ? " " + esc(x.checked_on) : "") + "</span></span></div>" +
        '<span class="hint">' + esc(x.publisher || "") + (x.used_for ? " · " + esc(x.used_for) : "") + "</span>" + (x.licence ? '<span class="hint">Licence: ' + esc(x.licence) + "</span>" : "") + (x.notes ? "<p>" + esc(x.notes) + "</p>" : "") +
        '<div class="acts"><button type="button" class="btn danger sm" data-act="delsrc" data-id="' + x.id + '">Delete</button></div></div>';
    }).join("");
    var lvls = S.cur_levels.map(function (lv) {
      var ls = S.cur_lessons.filter(function (l) { return l.level_id === lv.id; }).sort(function (a, b) { return a.number - b.number; });
      return '<div class="card"><div class="l1"><span class="t">' + esc(lv.code + " " + lv.name) + '</span><span class="pills"><span class="pill ' + (ls.length && ls.every(function (l) { return l.status === "ready"; }) ? "ok" : "") + '">' + ls.filter(function (l) { return l.status === "ready"; }).length + " / " + ls.length + " ready</span></span></div>" +
        '<span class="hint">' + esc(lv.summary || "") + "</span><ol style=\"margin:8px 0 0 18px;padding:0\">" + ls.map(function (l) {
          return "<li><a href=\"#/academic/lesson/" + l.id + "\">" + esc(l.title) + "</a> <span class=\"hint\">· " + esc(CSTATUS[l.status]) + " · " + curFiles(l.id).length + " files" + (l.navigate_ref ? " · Navigate " + esc(l.navigate_ref) : "") + "</span></li>";
        }).join("") + "</ol></div>";
    }).join("");
    return '<div class="panel"><div class="sec"><h3>The curriculum: General English A1 (the division and its lessons)</h3><p class="hint">Everything in the plan, level by level. Click a lesson to open its kit.</p><div class="cards">' + (lvls || '<p class="hint">No levels yet.</p>') + '</div></div><div class="sec"><h3>Books and sources</h3><div class="cards">' + (rows || '<p class="hint">No sources yet.</p>') + "</div></div>" +
      '<div class="sec"><h3>Add a source</h3><form data-form="addsrc" class="addbox"><div class="fields"><div class="f wide"><label for="sr1">Title</label><input id="sr1" name="title" required></div>' +
      '<div class="f"><label for="sr2">Type</label><select id="sr2" name="kind">' + opt(Object.keys(SRC_KINDS), "other", SRC_KINDS) + "</select></div>" +
      '<div class="f"><label for="sr3">Publisher or owner</label><input id="sr3" name="publisher"></div><div class="f wide"><label for="sr4">Link</label><input id="sr4" name="url" type="url"></div>' +
      '<div class="f wide"><label for="sr5">What it is used for</label><input id="sr5" name="used_for"></div>' +
      '<div class="f"><label for="sr6">Checked?</label><select id="sr6" name="checked">' + opt(Object.keys(SRC_CHECKED), "from_memory", SRC_CHECKED) + "</select></div>" +
      '<div class="f"><label for="sr7">Licence</label><input id="sr7" name="licence"></div><div class="f wide"><label for="sr8">Notes</label><textarea id="sr8" name="notes"></textarea></div></div>' +
      '<div class="acts"><button class="btn" type="submit">Add source</button></div></form></div></div>';
  }

  /* ---- student side: homework */
  function studentHomework(s) {
    var mine = S.assignments.filter(function (a) { return a.student_id === s.id; });
    if (!mine.length) return "";
    return '<div class="panel"><div class="sec"><h3>Your homework</h3><div class="cards">' + mine.map(function (a) {
      var open = a.status !== "reviewed";
      return '<div class="card"><div class="l1"><span class="t">' + esc(a.title) + '</span><span class="pills"><span class="pill ' + (a.status === "reviewed" ? "ok" : a.status === "submitted" ? "warn" : "") + '">' + (a.status === "reviewed" ? "Feedback ready" : a.status === "submitted" ? "Sent, waiting for feedback" : "To do") + "</span>" + (a.due_on ? '<span class="pill">Due ' + esc(a.due_on) + "</span>" : "") + "</span></div>" +
        (a.instructions ? "<p>" + esc(a.instructions) + "</p>" : "") +
        (a.status === "reviewed" && a.feedback ? '<div class="receipt"><b>Feedback from your teacher</b>\n' + esc(a.feedback) + "</div>" : "") +
        (a.sub_text && a.status !== "assigned" ? '<span class="hint">Your answer: ' + esc(a.sub_text.length > 140 ? a.sub_text.slice(0, 140) + "…" : a.sub_text) + "</span>" : "") +
        (open ? '<form data-form="submithw" data-id="' + a.id + '" class="addbox"><div class="f"><label for="h' + a.id + '">' + (a.status === "submitted" ? "Change your answer" : "Your answer") + '</label><textarea id="h' + a.id + '" name="text">' + esc(a.status === "submitted" ? a.sub_text : "") + '</textarea></div>' +
          '<div class="f"><label for="hf' + a.id + '">Or attach a file or recording (optional)</label><input id="hf' + a.id + '" name="file" type="file" accept="' + FILE_ACCEPT + '"><span class="hint">Up to 50 MB.</span></div><div class="acts"><button class="btn" type="submit">' + (a.status === "submitted" ? "Send again" : "Send to my teacher") + "</button></div></form>" : "") + "</div>";
    }).join("") + "</div></div></div>";
  }
  function submitHomework(id, d, done) {
    var a = byId(S.assignments, id); if (!a) return done();
    var file = d.file && d.file.size ? d.file : null, mime = null;
    if (file) { mime = checkFile(file); if (!mime) return done(); }
    if (!d.text && !file) { toast("Write your answer or attach a file.", true); return done(); }
    var bucket = sb.storage.from("materials"), path = null;
    Promise.resolve().then(function () {
      if (!file) return null;
      path = a.student_id + "/submissions/" + uid() + "-" + file.name.replace(/[^\w.\-]+/g, "-");
      toast("Uploading " + file.name + "…");
      return bucket.upload(path, file, { contentType: mime, upsert: false }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    }).then(function () {
      return sb.rpc("submit_assignment", { p_id: id, p_text: d.text || "", p_path: path, p_name: file ? file.name : null, p_mime: mime, p_size: file ? file.size : null });
    }).then(function (r) {
      if (r.error) { if (path) bucket.remove([path]); throw new Error(r.error.message); }
      toast("Sent to your teacher."); return refresh();
    }).catch(function (e) { toast(e.message || "Could not send.", true); }).then(done, done);
  }

  /* ---- Clear Academic: events */
  function academicClick(a, id, v) {
    if (a === "actab") { location.hash = "#/academic/" + v; return true; }
    if (a === "aclesson") { location.hash = "#/academic/lesson/" + id; return true; }
    if (a === "curblueprint") {
      var ta = $("#c_plan"); if (!ta) return true;
      if (ta.value.trim() && ta.value.trim() !== BLUEPRINT) ask("Replace the plan in the box with the standard plan?", "Replace").then(function (ok) { if (ok) ta.value = BLUEPRINT; });
      else ta.value = BLUEPRINT;
      return true;
    }
    if (a === "viewcur") { var vf = byId(S.cur_files, id), vc = vf && viewableCopy(vf); if (vc) openViewer(vc.file_path, vc.file_name, vc.mime); return true; }
    if (a === "playcur") {
      var pf = byId(S.cur_files, id), card = document.getElementById("cf" + id); if (!pf || !card) return true;
      var old = card.querySelector("audio"); if (old) { old.pause(); old.remove(); return true; }
      sb.storage.from("materials").createSignedUrl(pf.file_path, 3600).then(function (r) {
        if (r.error || !r.data) return toast("Could not load the audio. Try again.", true);
        var au = document.createElement("audio"); au.controls = true; au.autoplay = true; au.src = r.data.signedUrl; au.style.width = "100%"; au.style.marginTop = "8px"; card.appendChild(au);
      });
      return true;
    }
    if (a === "opencur") { var f = byId(S.cur_files, id); if (f) openStored(f.file_path, f.file_name, f.mime); return true; }
    if (a === "delcur") { ask("Delete this file from the lesson kit? Copies already sent to students stay with them.", "Delete file").then(function (ok) {
      if (!ok) return; var f2 = byId(S.cur_files, id); if (!f2) return;
      sb.storage.from("materials").remove([f2.file_path]).then(function () { return act(sb.from("cur_files").delete().eq("id", id), "File deleted."); }).then(refresh).catch(function (e) { toast(e.message || "Could not delete.", true); });
    }); return true; }
    if (a === "opensub") { var x = byId(S.assignments, id); if (x && x.sub_path) openStored(x.sub_path, x.sub_name, x.sub_mime); return true; }
    if (a === "delhw") { ask("Delete this homework and any answer the student sent?", "Delete").then(function (ok) {
      if (!ok) return; var h = byId(S.assignments, id);
      Promise.resolve(h && h.sub_path ? sb.storage.from("materials").remove([h.sub_path]) : null).then(function () { return act(sb.from("assignments").delete().eq("id", id), "Homework deleted."); }).then(refresh);
    }); return true; }
    if (a === "delsrc") { ask("Delete this source from the list?", "Delete").then(function (ok) { if (ok) act(sb.from("cur_sources").delete().eq("id", id), "Source deleted.").then(refresh); }); return true; }
    if (a === "newcp") { newCheckpoint(id, v); return true; }
    return false;
  }
  function academicChange(t, ch) {
    if (ch === "importpick") { importPick(t); return true; }
    if (ch === "curstatus") {
      act(sb.from("cur_lessons").update({ status: t.value, updated_at: new Date().toISOString() }).eq("id", t.getAttribute("data-id")).select("id")).then(function (rows) {
        if (!rows || !rows.length) { toast("Nothing was saved. Refresh and sign in again.", true); } else toast("Status saved: " + CSTATUS[t.value] + ".");
      }).then(refresh, refresh);
      return true;
    }
    if (ch === "attend") {
      var al = byId(S.lessons, t.getAttribute("data-id"));
      act(sb.from("lessons").update({ status: t.value }).eq("id", t.getAttribute("data-id")).select("id")).then(function (rows) {
        if (!rows || !rows.length) { toast("Nothing was saved. Refresh and sign in again.", true); return; }
        toast("Attendance saved."); return maybeCompletePackage(al && al.package_id);
      }).then(refresh, refresh);
      return true;
    }
    if (ch === "lcur") {
      var id = t.getAttribute("data-id"), l = byId(S.lessons, id), c = t.value ? byId(S.cur_lessons, t.value) : null;
      var patch = { cur_lesson_id: t.value || null };
      var prev = l && l.cur_lesson_id ? byId(S.cur_lessons, l.cur_lesson_id) : null;
      if (l && (!l.topic || (prev && l.topic === prev.title))) patch.topic = c ? c.title : null;
      act(sb.from("lessons").update(patch).eq("id", id), "Linked.").then(refresh, refresh);
      return true;
    }
    return false;
  }
  function academicSubmit(kind, id, d, done) {
    if (kind === "savecur") {
      act(sb.from("cur_lessons").update({ title: d.title, status: d.status, navigate_ref: nul(d.navigate_ref), objective: nul(d.objective), grammar: nul(d.grammar), vocabulary: nul(d.vocabulary), plan: nul(d.plan), homework: nul(d.homework), omitted: nul(d.omitted), culture_note: nul(d.culture_note), teacher_notes: nul(d.teacher_notes), updated_at: new Date().toISOString() }).eq("id", id), "Lesson saved.").then(refresh).then(done, done);
    } else if (kind === "addcurfile") { uploadCurFile(id, d, done);
    } else if (kind === "sendkit") { sendKit(id, d, done);
    } else if (kind === "newhw") {
      act(sb.from("assignments").insert({ student_id: d.student_id, title: d.title, instructions: nul(d.instructions), due_on: nul(d.due_on) }), "Homework assigned.").then(refresh).then(done, done);
    } else if (kind === "hwfeedback") {
      act(sb.from("assignments").update({ feedback: d.feedback, status: "reviewed", reviewed_at: new Date().toISOString() }).eq("id", id), "Feedback sent.").then(refresh).then(done, done);
    } else if (kind === "addsrc") {
      act(sb.from("cur_sources").insert({ title: d.title, kind: d.kind, publisher: nul(d.publisher), url: nul(d.url), used_for: nul(d.used_for), checked: d.checked, checked_on: d.checked === "from_memory" ? null : todayStr(), licence: nul(d.licence), notes: nul(d.notes), position: S.cur_sources.length + 1 }), "Source added.").then(refresh).then(done, done);
    } else if (kind === "importkit") { importKit(done);
    } else if (kind === "submithw") { submitHomework(id, d, done);
    } else return false;
    return true;
  }

  /* ------------------------------------------------------------ events */
  function formData(form) { var o = {}; new FormData(form).forEach(function (v, k) { o[k] = typeof v === "string" ? v.trim() : v; }); return o; }
  function nul(v) { return v === "" || v == null ? null : v; }

  function liveSchedule(e) {
    var f = e.target.form;
    if (!f || f.getAttribute("data-form") !== "schedule" || e.target.getAttribute("data-change") === "schedpkg") return false;
    UI.sched = readSched(f); var box = $("#schedprev"); if (box) box.innerHTML = schedPreview(UI.sched);
    return true;
  }
  function onInput(e) {
    if (window.CLEAR_PL && window.CLEAR_PL.input(e)) return;
    if (e.target.id === "q") { UI.q = e.target.value; $("#list").innerHTML = studentRows(); return; }
    if (livePrices(e)) return;
    if (e.target.form && e.target.form.getAttribute("data-form") === "addpay") {
      var pf = e.target.form;
      if (e.target.name === "egp_rate" && pf.currency.value === "EGP") { var pk2 = byId(S.packages, pf.getAttribute("data-id")); if (pk2 && Number(pf.egp_rate.value) > 0) pf.amount.value = pkgRemaining(pk2, "EGP", Number(pf.egp_rate.value)); }
      payEq(pf); return;
    }
    liveSchedule(e);
  }
  function onChange(e) {
    var t = e.target, ch = t.getAttribute("data-change");
    if (livePrices(e)) return;
    if (ch === "paytoday") { UI.payToday = t.checked; return render(); }
    if (liveSchedule(e)) return;
    if (window.CLEAR_PL && window.CLEAR_PL.change(t, ch)) return;
    if (academicChange(t, ch)) return;
    if (ch === "viewtz") { UI.viewTz = t.value; try { localStorage.setItem("clear-viewtz", t.value); } catch (e) { /* storage blocked */ } return render(); }
    if (ch === "schedpkg") {
      var s9 = byId(S.students, t.getAttribute("data-id")), p9 = byId(S.packages, t.value);
      if (s9 && p9) { UI.sched = initSched(s9, p9); render(); }
      return;
    }
    if (t.id === "flt") { UI.filter = t.value; $("#list").innerHTML = studentRows(); return; }
    if (ch === "country") {
      var f0 = t.form, c0 = countryByName(t.value);
      if (c0 && f0.dial && !f0.phone_local.value.trim()) f0.dial.value = c0[1];
      return;
    }
    if (ch === "pkgprev") {
      var f = t.form; $("#pkgprev").innerHTML = pkgPreview(f.program.value, parseInt(f.levels.value, 10)); return;
    }
    if (ch === "paycur") {
      var pkg = byId(S.packages, t.getAttribute("data-id"));
      if (pkg) t.form.amount.value = pkgRemaining(pkg, t.value, Number(t.form.egp_rate.value) || null);
      payEq(t.form);
      return;
    }
    if (ch === "lstatus") {
      var id = t.getAttribute("data-id"), l = byId(S.lessons, id);
      act(sb.from("lessons").update({ status: t.value }).eq("id", id).select("id"), "Lesson updated.").then(function (rows) {
        if (!rows || !rows.length) { toast("Nothing was saved. Refresh the page and sign in again; if it repeats, your account may not have admin rights.", true); return; }
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
    if (window.CLEAR_PL && window.CLEAR_PL.click(a, id, v, b)) return;
    if (academicClick(a, id, v)) return;
    if (a === "lmark") {
      var ll = byId(S.lessons, id);
      act(sb.from("lessons").update({ status: v }).eq("id", id).select("id"), "Lesson updated.").then(function (rows) {
        if (!rows || !rows.length) { toast("Nothing was saved. Refresh and sign in again.", true); return; }
        return maybeCompletePackage(ll && ll.package_id);
      }).then(refresh, refresh);
      return;
    }
    if (a === "tab") { UI.tab = v; UI.sent = ""; return renderAuth(); }
    if (a === "again") { UI.sent = ""; return renderAuth(); }
    if (a === "paytab") { UI.payTab = v; return render(); }
    if (a === "ptab") { UI.ptab = v; render(); window.scrollTo(0, 0); return; }
    if (a === "fold") { UI.fold = UI.fold || {}; UI.fold[v] = b.getAttribute("aria-expanded") !== "true"; var fy = window.scrollY; render(); window.scrollTo(0, fy); return; }
    if (a === "fetchrate") return updateRateNow(b);
    if (a === "copymsg") { var mt = $("#msgtext"); return copyText(mt ? mt.value : ""); }
    if (a === "wamsg") { var mw = $("#msgtext"); if (mw) window.open("https://wa.me/?text=" + encodeURIComponent(mw.value), "_blank", "noopener"); return; }
    if (a === "copysql") return copyText(SETUP_SQL);
    if (a === "theme") return toggleTheme();
    if (a === "signout") return signOut();
    if (a === "go") { location.hash = "#/" + v; return; }
    if (a === "open") { location.hash = "#/students/" + id; return; }
    if (a === "back") { location.hash = "#/students"; return; }
    if (a === "addtoggle") { UI.add = !UI.add; return render(); }
    if (a === "print") return window.print();
    if (a === "csv") return exportCsv();
    if (a === "addday" || a === "delday") {
      var sf = $('form[data-form="schedule"]'), sy = window.scrollY; if (!sf) return;
      var st2 = UI.sched = readSched(sf);
      if (a === "delday") st2.rows.splice(parseInt(b.getAttribute("data-i"), 10), 1);
      else {
        var used = st2.rows.map(function (r) { return r.dow; }), nd = DOWS.filter(function (d) { return used.indexOf(d[0]) < 0; })[0];
        st2.rows.push({ dow: nd ? nd[0] : 1, time: st2.rows.length ? st2.rows[st2.rows.length - 1].time : "21:00", min: st2.rows.length ? st2.rows[st2.rows.length - 1].min : 60 });
      }
      render(); window.scrollTo(0, sy); return;
    }
    if (a === "applylink") {
      var url = S.settings && S.settings.default_meeting_url;
      if (!url) return toast("Save a default lesson link first.", true);
      return act(sb.from("lessons").update({ meeting_url: url }).eq("status", "scheduled").is("meeting_url", null), "Link added to your upcoming lessons.").then(refresh);
    }
    if (a === "openfile") return openMaterial(id);
    if (a === "delmat") return ask("Delete this file? The student will no longer see it.", "Delete file").then(function (ok) {
      if (!ok) return; var m = byId(S.materials, id); if (!m) return;
      sb.storage.from("materials").remove([m.file_path]).then(function () { return act(sb.from("materials").delete().eq("id", id), "File deleted."); }).then(refresh).catch(function (e) { toast(e.message || "Could not delete.", true); });
    });
    if (a === "openreceipt") { location.hash = "#/receipt/" + id; return; }
    if (a === "copyr") { var c1 = payContext(id); return copyText(c1 && c1.s ? receiptText(c1.p, c1.s, c1.pkg) : ""); }
    if (a === "dlpng") {
      var c2 = payContext(id); if (!c2 || !c2.s) return;
      return receiptPNG(c2).then(function (blob) { if (!blob) throw new Error("no image"); downloadBlob(c2.p.receipt_no + "-" + c2.s.full_name.replace(/[^\w]+/g, "-") + ".png", blob); }).catch(function () { toast("Could not make the image here. Use Save as PDF instead.", true); });
    }
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
      if (!ok) return;
      var paths = S.materials.filter(function (m) { return m.student_id === id; }).map(function (m) { return m.file_path; })
        .concat(S.assignments.filter(function (x) { return x.student_id === id && x.sub_path; }).map(function (x) { return x.sub_path; }));
      Promise.resolve(paths.length ? sb.storage.from("materials").remove(paths) : null).then(function () { return act(sb.from("students").delete().eq("id", id), "Student deleted."); }).then(function () { location.hash = "#/students"; return refresh(); });
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
    if (kind === "code") return doCode(d);
    if (btn) btn.disabled = true;
    var done = function () { if (btn) btn.disabled = false; };
    if (window.CLEAR_PL && window.CLEAR_PL.submit(kind, id, d, done, form)) return;
    if (academicSubmit(kind, id, d, done)) return;
    if (kind === "addstudent") {
      act(sb.from("students").insert({ full_name: d.full_name, email: nul(d.email), phone: joinPhone(d.dial, d.phone_local), country: nul(d.country), program: nul(d.program), status: d.status, goal: nul(d.goal) }).select().single(), "Student added.")
        .then(function (r) { UI.add = false; return loadAll().then(function () { location.hash = "#/students/" + r.id; render(); }); }).then(done, done);
    } else if (kind === "savestudent") {
      act(sb.from("students").update({ full_name: d.full_name, email: nul(d.email), phone: joinPhone(d.dial, d.phone_local), country: nul(d.country), program: nul(d.program), cefr: nul(d.cefr), level_code: nul(d.level_code), status: d.status, goal: nul(d.goal), payment_due: d.payment_due === "1", payment_due_note: nul(d.payment_due_note) }).eq("id", id), "Saved.").then(refresh).then(done, done);
    } else if (kind === "levelresult") {
      act(sb.from("level_results").insert({ student_id: id, level_code: d.level_code, outcome: d.outcome, score: d.score === "" || d.score == null ? null : Number(d.score), note: nul(d.note) }), "Result saved.").then(refresh).then(done, done);
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
      var wp = String(d.when || "").split("T"), when = new Date(wp.length === 2 ? zonedToMs(wp[0], wp[1], EG) : NaN);
      if (isNaN(when.getTime())) { toast("Choose a date and time.", true); return done(); }
      act(sb.from("lessons").insert({ student_id: id, package_id: nul(d.package_id), starts_at: when.toISOString(), duration_min: parseInt(d.duration, 10) || 60, topic: nul(d.topic) }), "Lesson scheduled.").then(function () {
        var p = byId(S.packages, d.package_id);
        if (p && !p.starts_on) {
          var day = localInputValue(when).slice(0, 10);
          return sb.from("packages").update({ starts_on: day, expires_on: addDays(day, 70), status: p.status === "pending" ? "pending" : "active" }).eq("id", p.id);
        }
      }).then(refresh).then(done, done);
    } else if (kind === "addmaterial") {
      uploadMaterial(id, d, done);
    } else if (kind === "schedule") {
      submitSchedule(form, done);
    } else if (kind === "saverate") {
      var cfg0 = S.settings || {}, upd = { usd_egp_rate: Number(d.usd_egp_rate), default_meeting_url: nul(d.default_meeting_url) };
      if (hasPriceCols()) {
        upd.instapay = nul(d.instapay);
        if (Number(d.usd_egp_rate) !== Number(cfg0.usd_egp_rate)) { upd.rate_updated_at = new Date().toISOString(); upd.rate_source = "Entered by hand"; }
      }
      act(sb.from("settings").update(upd).eq("id", 1), "Saved.").then(refresh).then(done, done);
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
    return act(sb.from("payments").insert({ student_id: pkg.student_id, package_id: pkgId, amount: amount, currency: d.currency, method: d.method, reference: nul(d.reference), paid_on: d.paid_on, egp_rate: Number(d.egp_rate) || liveRate() }).select().single(), null).then(function (pay) {
      return loadAll().then(function () {
        var p2 = byId(S.packages, pkgId), s = byId(S.students, pkg.student_id), jobs = [];
        if (p2 && p2.status === "pending" && pkgIsPaid(p2)) jobs.push(sb.from("packages").update({ status: "active" }).eq("id", pkgId));
        if (s && (s.status === "lead" || s.status === "test") && pkgIsPaid(p2)) jobs.push(sb.from("students").update({ status: "active" }).eq("id", s.id));
        return Promise.all(jobs);
      }).then(function () { toast("Payment recorded. Receipt " + pay.receipt_no + "."); location.hash = "#/receipt/" + pay.id; return refresh(); });
    });
  }

  function doCode(d) {
    var btn = $('form[data-form="code"] button[type="submit"]'); if (btn) btn.disabled = true;
    var token = String(d.code || "").replace(/\s+/g, "");
    var fail = function (msg) { renderAuth(msg); };
    var verify = function (type) { return sb.auth.verifyOtp({ email: UI.sent, token: token, type: type }); };
    verify("email").then(function (r) { return r.error ? verify("signup") : r; }).then(function (r) {
      if (r.error) return fail("That code is not right or has expired. Request a new one.");
      session = r.data.session; UI.sent = ""; return enter();
    }, function (er) { fail(er.message); });
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
  window.__clear = { esc: esc, priceFor: priceFor, api: function () {
    return { sb: sb, esc: esc, toast: toast, act: act, ask: ask, unwrap: unwrap, fmtDT: fmtDT, render: render, refresh: refresh, nul: nul, logo: logo, cfgUrl: function () { return window.CLEAR_CONFIG.url; } };
  } };
})();
