/* CLEAR online placement test: learner side.
   The server owns the paper, the order, the clocks and the answer key. This page only shows the open block,
   keeps a visible countdown, and reports answers and integrity events. */
(function () {
  "use strict";
  var cfg = window.CLEAR_CONFIG;
  var sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
  var WA = "201120223509";
  var KEY = "clear_pl_token";
  var app = document.getElementById("app");
  var timerEl = document.getElementById("timer");
  var dock = document.getElementById("dock");
  var S = { token: null, lead: null, st: null, ready: false, camera: false, stream: null, busy: false,
            tick: null, blockDl: 0, itemDl: 0, collected: [], cur: 0, order: {}, quiet: 0, hiddenAt: 0, blurAt: 0,
            ev: [], fsOk: !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen),
            analyser: null, ctx: null, spk: null, plays: 0, audio: null };

  function $(s, r) { return (r || document).querySelector(s); }
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmt(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }

  /* ---------- server calls (retry quietly; never lose an answer) ---------- */
  async function rpc(name, args, tries) {
    var n = tries || 4, last;
    for (var i = 0; i < n; i++) {
      var r = await sb.rpc(name, args);
      if (!r.error) return r.data;
      last = r.error;
      if (r.error.code === "22023") throw r.error;       // a real refusal from the server, not a network problem
      await sleep(700 * (i + 1));
    }
    throw last;
  }

  /* ---------- integrity tracker ---------- */
  function log(kind, extra) {
    S.ev.push(Object.assign({ kind: kind, section: S.st ? S.st.section : null, at: new Date().toISOString(),
      detail: Date.now() < S.quiet ? "expected" : null }, extra || {}));
  }
  function flush() {
    if (!S.token || !S.ev.length) return;
    var batch = S.ev.splice(0, 50);
    rpc("pl_event", { p_token: S.token, p_events: batch }, 2).catch(function () { S.ev = batch.concat(S.ev); });
  }
  setInterval(flush, 6000);
  function inFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function activeTest() { return S.ready && S.st && S.st.status !== "submitted"; }
  function goFs() {
    var el = document.documentElement, f = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!f) { log("fullscreen_unavailable"); return Promise.resolve(false); }
    S.quiet = Date.now() + 3000;
    return Promise.resolve(f.call(el)).then(function () { return true; }, function () { log("fullscreen_unavailable", { detail: "denied" }); return false; });
  }
  function gate() { $("#gate").classList.toggle("on", S.fsOk && activeTest() && !inFs() && !S.noGate); }
  function onFs() {
    if (!activeTest()) return;
    log(inFs() ? "fullscreen_enter" : "fullscreen_exit");
    gate();
  }
  document.addEventListener("fullscreenchange", onFs);
  document.addEventListener("webkitfullscreenchange", onFs);
  $("#gateBtn").addEventListener("click", function () { goFs().then(gate); });
  document.addEventListener("visibilitychange", function () {
    if (!activeTest()) return;
    if (document.hidden) { S.hiddenAt = Date.now(); log("tab_hidden"); }
    else { log("tab_visible", { away_ms: S.hiddenAt ? Date.now() - S.hiddenAt : null }); S.hiddenAt = 0; flush(); showLeft(); }
  });
  window.addEventListener("blur", function () { if (activeTest() && !document.hidden) S.blurAt = Date.now(); });
  window.addEventListener("focus", function () {
    if (activeTest() && S.blurAt) { var d = Date.now() - S.blurAt; S.blurAt = 0; if (d > 1500) log("window_blur", { away_ms: d }); }
  });
  ["copy", "cut", "paste", "contextmenu", "dragstart"].forEach(function (k) {
    document.addEventListener(k, function (e) {
      if (!activeTest()) return;
      e.preventDefault(); log(k === "contextmenu" ? "context_menu" : (k === "paste" ? "paste" : "copy"));
    });
  });
  function showLeft() {
    if (Date.now() < S.quiet) return;
    var n = $("#leftNote"); if (n) n.remove();
    var d = document.createElement("div"); d.id = "leftNote"; d.className = "note";
    d.innerHTML = 'We noticed you left this page. It is recorded for your teacher. Please stay on the test.<br><span class="ar" dir="rtl">لاحظنا أنك غادرت هذه الصفحة، وهذا يُسجَّل ويراه المعلّم. من فضلك ابقَ في الاختبار.</span>';
    app.insertBefore(d, app.firstChild);
  }

  /* ---------- timer ---------- */
  function setTimer(dlFn) {
    stopTimer();
    timerEl.classList.add("on");
    var f = function () {
      var left = dlFn();
      timerEl.textContent = fmt(left);
      timerEl.classList.toggle("low", left <= 10000);
    };
    f(); S.tick = setInterval(function () { f(); if (S.onTick) S.onTick(); }, 250);
  }
  function stopTimer() { if (S.tick) clearInterval(S.tick); S.tick = null; S.onTick = null; timerEl.classList.remove("on", "low"); }

  /* ---------- small helpers ---------- */
  function hash(s) { var h = 1779033703 ^ s.length; for (var i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } return h >>> 0; }
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function shuffled(item) {      // display order is shuffled per person; we always send the original index back
    if (S.order[item.id]) return S.order[item.id];
    var idx = item.options.map(function (_, i) { return i; }), r = rng(hash(S.token + item.id));
    for (var i = idx.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    return (S.order[item.id] = idx);
  }
  function bi(en, ar) { return '<div class="bi"><div>' + en + '</div><div class="ar" dir="rtl" lang="ar">' + ar + '</div></div>'; }
  function screen(html) { app.innerHTML = html; window.scrollTo(0, 0); }
  function dockOn(stuck) { dock.hidden = false; $("#stuckBtn").hidden = !stuck; }

  /* ---------- text (English + Arabic) ---------- */
  var T = {
    vocab_grammar: {
      en: '<div class="label">Section 1 of 4</div><h2>Vocabulary and grammar</h2><p>You will see short questions. Choose the best answer.</p><p>Every question has its own timer in the <b>top right corner</b>. When the time is over, we move on automatically.</p><p>If you are not sure, choose your best guess or press <b>Next</b>. Some questions may feel easy and some difficult. That is normal.</p><p>If you feel stuck, press <b>I\'m stuck</b> at the bottom to end this section.</p>',
      ar: '<div class="label">القسم 1 من 4</div><h2>المفردات والقواعد</h2><p>ستظهر لك أسئلة قصيرة. اختر الإجابة الأنسب.</p><p>لكل سؤال مؤقّت خاص به في <b>أعلى الزاوية اليمنى</b>. عند انتهاء الوقت ننتقل تلقائيًا إلى السؤال التالي.</p><p>إن لم تكن متأكدًا فاختر أفضل تخمين أو اضغط <b>التالي</b>. قد تبدو بعض الأسئلة سهلة وبعضها صعبًا، وهذا طبيعي.</p><p>إذا شعرت أنك عالق فاضغط <b>أنا عالق</b> في الأسفل لإنهاء هذا القسم.</p>' },
    reading: {
      en: '<div class="label">Section 2 of 4</div><h2>Reading</h2><p>You will read a short text and answer three questions about it.</p><p>One timer in the <b>top right corner</b> covers the text and its questions. Read carefully, then answer. You cannot go back to an earlier text.</p><p>If you feel stuck, press <b>I\'m stuck</b> at the bottom to end this section.</p>',
      ar: '<div class="label">القسم 2 من 4</div><h2>القراءة</h2><p>ستقرأ نصًا قصيرًا ثم تجيب عن ثلاثة أسئلة عنه.</p><p>مؤقّت واحد في <b>أعلى الزاوية اليمنى</b> يشمل النص وأسئلته. اقرأ بتركيز ثم أجب. لا يمكن الرجوع إلى نص سابق.</p><p>إذا شعرت أنك عالق فاضغط <b>أنا عالق</b> في الأسفل لإنهاء هذا القسم.</p>' },
    listening: {
      en: '<div class="label">Section 3 of 4</div><h2>Listening</h2><p>Press <b>Play</b> to hear a short recording. You can play it <b>{plays} times</b>. Then answer the three questions.</p><p>Use headphones if you can. The timer starts when the page opens, so press Play straight away.</p><p>If you feel stuck, press <b>I\'m stuck</b> at the bottom to end this section.</p>',
      ar: '<div class="label">القسم 3 من 4</div><h2>الاستماع</h2><p>اضغط <b>تشغيل</b> لتسمع تسجيلًا قصيرًا. يمكنك تشغيله <b>{plays} مرات</b> فقط. ثم أجب عن الأسئلة الثلاثة.</p><p>يُفضَّل استخدام سماعات. يبدأ المؤقّت عند ظهور الصفحة، فاضغط «تشغيل» فورًا.</p><p>إذا شعرت أنك عالق فاضغط <b>أنا عالق</b> في الأسفل لإنهاء هذا القسم.</p>' },
    speaking: {
      en: '<div class="label">Section 4 of 4</div><h2>Speaking</h2><p>You will see four short tasks. For each one you get a few seconds to think, then <b>recording starts automatically</b>.</p><p>Speak naturally. Press <b>Finish</b> when you are done. A teacher will listen to your answers.</p><p>Your voice is always recorded. The camera is your choice.</p>',
      ar: '<div class="label">القسم 4 من 4</div><h2>التحدّث</h2><p>ستظهر لك أربع مهام قصيرة. لكل مهمة بضع ثوانٍ للتفكير ثم <b>يبدأ التسجيل تلقائيًا</b>.</p><p>تحدّث بشكل طبيعي واضغط <b>إنهاء</b> عندما تنتهي. سيستمع معلّم إلى إجاباتك.</p><p>الصوت يُسجَّل دائمًا، أما الكاميرا فهي اختيارك.</p>' }
  };

  /* ---------- start: find the attempt ---------- */
  var qs = new URLSearchParams(location.search);
  async function boot() {
    try {
      var t = qs.get("t") || null, lead = qs.get("lead");
      if (!t) { try { t = localStorage.getItem(KEY); } catch (e) {} }
      var st;
      if (t) {
        try { st = await rpc("pl_state", { p_token: t }, 3); } catch (e) { if (e.code !== "22023") throw e; st = null; t = null; }
      }
      if (!st && lead) st = await rpc("pl_start", { p_lead: lead, p_agent: navigator.userAgent });
      if (!st) { return screen('<div class="card">' + bi('<h2>This link is not valid</h2><p>Please open the link we sent you, or contact us on WhatsApp.</p>', '<h2>الرابط غير صالح</h2><p>من فضلك افتح الرابط الذي أرسلناه لك، أو تواصل معنا على واتساب.</p>') + '</div>'), dockOn(false); }
      S.token = st.token; S.lead = lead;
      try { localStorage.setItem(KEY, S.token); } catch (e) {}
      if (!qs.get("t")) { history.replaceState(null, "", "?t=" + S.token); }
      S.st = st; render();
    } catch (e) {
      var msg = e && e.message || "";
      var already = /already_done/.test(msg), notallowed = /not_allowed/.test(msg);
      screen('<div class="card">' + bi(
        already ? '<h2>You have already taken the test</h2><p>Your teacher is reviewing it. We will send your result on WhatsApp.</p>' : notallowed ? '<h2>We could not start your test</h2><p>Please contact us on WhatsApp and we will help.</p>' : '<h2>We could not connect</h2><p>Please check your internet and refresh this page. Your answers are saved.</p>',
        already ? '<h2>لقد أجريت الاختبار من قبل</h2><p>معلّمك يراجعه الآن وسنرسل لك النتيجة على واتساب.</p>' : notallowed ? '<h2>تعذّر بدء الاختبار</h2><p>من فضلك تواصل معنا على واتساب لنساعدك.</p>' : '<h2>تعذّر الاتصال</h2><p>تأكد من الإنترنت وحدّث الصفحة. إجاباتك محفوظة.</p>') + '</div>');
      dockOn(false);
    }
  }

  /* ---------- router ---------- */
  function render() {
    var st = S.st; stopTimer(); dockOn(false); gate();
    if (st.status === "submitted") return thanks();
    if (!S.ready) return check();
    dockOn(st.stage < 4);
    if (st.stage >= 4) return st.intro ? speakIntro() : speakRun();
    if (st.intro) return secIntro();
    if (!st.block) return next();
    return block();
  }

  /* ---------- welcome + microphone / camera check ---------- */
  function check() {
    dockOn(false);
    var camOk = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    screen('<div class="card">' + bi(
      '<h1>Welcome</h1><p>This test places you in the right CLEAR level. Please:</p><ul><li>Sit in a quiet place with a charged device and a stable connection.</li><li>Stay on this page. The test opens in <b>full screen</b>. Leaving the page or full screen is recorded for your teacher.</li><li>Expect up to <b>30 minutes</b> for the first three sections, then a few minutes of speaking.</li></ul><p>You will not see a score on screen. After a teacher listens to your speaking, we send your result and plan to your WhatsApp.</p>',
      '<h1>مرحبًا بك</h1><p>هذا الاختبار يحدّد مستواك المناسب في CLEAR. من فضلك:</p><ul><li>اجلس في مكان هادئ مع جهاز مشحون واتصال مستقر.</li><li>ابقَ في هذه الصفحة. يفتح الاختبار <b>بملء الشاشة</b>، والخروج من الصفحة أو من ملء الشاشة يُسجَّل ويراه معلّمك.</li><li>تحتاج حتى <b>30 دقيقة</b> للأقسام الثلاثة الأولى، ثم دقائق قليلة للتحدّث.</li></ul><p>لن تظهر لك نتيجة على الشاشة. بعد أن يستمع معلّم إلى تحدّثك نرسل نتيجتك وخطتك على واتساب.</p>') + '</div>' +
      '<div class="card soft"><div class="label">Microphone and camera · الميكروفون والكاميرا</div>' +
      '<p id="micMsg">Press the button, allow the microphone, then say a few words. The bar should move.<br><span class="ar" dir="rtl">اضغط الزر واسمح بالميكروفون ثم قل بضع كلمات. يجب أن يتحرك الشريط.</span></p>' +
      '<div class="bar" aria-hidden="true"><i id="lvl"></i></div><div style="height:12px"></div>' +
      '<div class="row"><button class="btn secondary" id="micBtn" type="button"' + (camOk ? '' : ' disabled') + '>Test microphone · اختبر الميكروفون</button>' +
      '<label class="row" style="gap:8px"><input type="checkbox" id="camChk"> <span>Use my camera (optional) · استخدم الكاميرا (اختياري)</span></label></div>' +
      '<div style="height:12px"></div><video id="prev" class="prev" playsinline muted hidden></video></div>' +
      (S.fsOk ? '' : '<div class="note">On this device full screen is not available. Please stay on this page. · ميزة ملء الشاشة غير متاحة على هذا الجهاز؛ من فضلك ابقَ في هذه الصفحة.</div>') +
      '<div class="row end"><button class="btn" id="startBtn" type="button" disabled>Start the test · ابدأ الاختبار</button></div>');
    var micOk = false;
    async function openStream() {
      closeStream(); S.quiet = Date.now() + 8000;
      var want = $("#camChk").checked;
      try {
        S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: want ? { facingMode: "user", width: 640, height: 480 } : false });
        S.camera = want && S.stream.getVideoTracks().length > 0;
      } catch (e) {
        if (want) { $("#camChk").checked = false; S.camera = false; try { S.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e2) { S.stream = null; } }
        else S.stream = null;
      }
      var v = $("#prev");
      if (S.stream && S.camera) { v.srcObject = S.stream; v.hidden = false; v.play().catch(function () {}); } else { v.hidden = true; }
      if (!S.stream) { $("#micMsg").innerHTML = 'We cannot reach your microphone. Allow it in the browser, or press <b>I need help</b>.<br><span class="ar" dir="rtl">لا نستطيع الوصول إلى الميكروفون. اسمح به من المتصفح أو اضغط «أحتاج مساعدة».</span>'; return; }
      meter($("#lvl"));
      micOk = true; $("#startBtn").disabled = false;
      $("#micMsg").innerHTML = '<span class="ok">Microphone ready.</span> Say a few words to see the bar move.<br><span class="ar ok" dir="rtl">الميكروفون يعمل. قل بضع كلمات لترى الشريط يتحرك.</span>';
    }
    $("#micBtn").addEventListener("click", openStream);
    $("#camChk").addEventListener("change", function () { if (S.stream) openStream(); });
    $("#startBtn").addEventListener("click", async function () {
      if (!micOk) return;
      S.ready = true; closeStream(); log("resume", { detail: "start" });
      await goFs();
      render();
    });
    dockOn(false); $("#dock").hidden = false;
  }
  function closeStream() { if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; } S.analyser = null; if (S.raf) cancelAnimationFrame(S.raf); }
  function meter(bar) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      S.ctx = S.ctx || new AC(); if (S.ctx.resume) S.ctx.resume(); var src = S.ctx.createMediaStreamSource(S.stream);
      var an = S.ctx.createAnalyser(); an.fftSize = 512; src.connect(an); S.analyser = an;
      var buf = new Uint8Array(an.fftSize);
      (function loop() {
        if (!S.analyser || !document.body.contains(bar)) return;
        an.getByteTimeDomainData(buf); var s = 0; for (var i = 0; i < buf.length; i++) { var d = (buf[i] - 128) / 128; s += d * d; }
        bar.style.width = Math.min(100, Math.sqrt(s / buf.length) * 320) + "%"; S.raf = requestAnimationFrame(loop);
      })();
    } catch (e) {}
  }

  /* ---------- section instruction page ---------- */
  function secIntro() {
    var st = S.st, t = T[st.section];
    var plays = String(st.plays || 2);
    screen('<div class="card">' + bi(t.en.replace("{plays}", plays), t.ar.replace("{plays}", plays)) + '</div><div class="row end"><button class="btn" id="go" type="button">Start · ابدأ</button></div>');
    dockOn(false); $("#dock").hidden = false;
    $("#go").addEventListener("click", function () { next(); });
  }
  async function next(answers, scope) {
    if (S.busy) return; S.busy = true; stopTimer();
    screen('<div class="card soft"><p>One moment… · لحظة…</p></div>');
    try {
      S.st = scope ? await rpc("pl_skip", { p_token: S.token, p_answers: answers || null, p_scope: scope })
                   : await rpc("pl_next", { p_token: S.token, p_answers: answers || null });
    } catch (e) {
      S.busy = false;
      screen('<div class="card">' + bi('<p>Connection problem. We will try again.</p>', '<p>مشكلة في الاتصال. سنحاول مرة أخرى.</p>') + '</div>');
      setTimeout(function () { render(); }, 2500); return;
    }
    S.busy = false; S.collected = []; S.cur = 0; render();
  }

  /* ---------- a block of questions ---------- */
  function optButtons(item, chosen) {
    var ord = shuffled(item), letters = "ABCD";
    return '<div class="opts">' + ord.map(function (oi, pos) {
      return '<button type="button" class="opt" data-i="' + oi + '" aria-pressed="' + (chosen === oi) + '"><span class="k">' + letters[pos] + '</span><span>' + esc(item.options[oi]) + '</span></button>';
    }).join("") + '</div>';
  }
  function block() {
    var b = S.st.block, isVg = b.section === "vocab_grammar";
    S.blockDl = performance.now() + b.remaining_ms;
    S.chosen = {}; Object.keys(S.st.answered || {}).forEach(function (k) { S.chosen[k] = S.st.answered[k]; });
    dockOn(true);
    if (isVg) return vgItem(b);
    passageBlock(b);
  }
  function submitAll() {
    var out = Object.keys(S.chosen).map(function (k) { return { item: k, choice: S.chosen[k], ms: (S.ms && S.ms[k]) || null }; });
    next(out);
  }
  function vgItem(b) {
    var items = b.items;
    // resume: skip items already answered
    while (S.cur < items.length && S.chosen[items[S.cur].id] != null) S.cur++;
    if (S.cur >= items.length) return submitAll();
    var it = items[S.cur], per = (b.per_s || 30) * 1000, started = performance.now();
    S.itemDl = Math.min(started + per, S.blockDl);
    screen('<div class="card q"><p class="stem">' + esc(it.stem) + '</p>' + optButtons(it, S.chosen[it.id]) + '</div>' +
      '<div class="row end"><button class="btn" id="nx" type="button">Next · التالي</button></div>');
    S.ms = S.ms || {};
    var done = false;
    function commit() {
      if (done) return; done = true;
      if (S.chosen[it.id] != null) {
        S.ms[it.id] = Math.round(performance.now() - started);
        sb.rpc("pl_answer", { p_token: S.token, p_answers: [{ item: it.id, choice: S.chosen[it.id], ms: S.ms[it.id] }] }).then(function () {}, function () {});
      }
      S.cur++;
      if (S.cur >= items.length || performance.now() >= S.blockDl) submitAll(); else vgItem(b);
    }
    app.querySelectorAll(".opt").forEach(function (btn) {
      btn.addEventListener("click", function () {
        S.chosen[it.id] = parseInt(btn.getAttribute("data-i"), 10);
        app.querySelectorAll(".opt").forEach(function (x) { x.setAttribute("aria-pressed", x === btn ? "true" : "false"); });
      });
    });
    $("#nx").addEventListener("click", commit);
    setTimer(function () { return S.itemDl - performance.now(); });
    S.onTick = function () { if (performance.now() >= S.itemDl) commit(); };
  }
  function passageBlock(b) {
    var p = b.passage || {}, listening = b.section === "listening", plays = S.st.plays || 2;
    S.plays = 0; stopAudio();
    var head = '';
    if (listening) {
      head = '<div class="card soft"><div class="row"><button class="btn" id="play" type="button">Play · تشغيل</button><span id="playInfo" class="muted">0 / ' + plays + '</span></div></div>';
    } else {
      head = '<div class="passage q">' + (p.title ? '<h3>' + esc(p.title) + '</h3>' : '') + '<p>' + esc(p.body) + '</p></div>';
    }
    var qhtml = b.items.map(function (it, i) {
      return '<div class="qblock q" data-id="' + it.id + '"><p class="stem" style="font-size:19px">' + (i + 1) + '. ' + esc(it.stem) + '</p>' + optButtons(it, S.chosen[it.id]) + '</div>';
    }).join("");
    screen(head + '<div class="card">' + qhtml + '</div><div class="row end"><button class="btn" id="nx" type="button">Next · التالي</button></div>');
    app.querySelectorAll(".qblock").forEach(function (qb) {
      var id = qb.getAttribute("data-id"), start = performance.now();
      qb.querySelectorAll(".opt").forEach(function (btn) {
        btn.addEventListener("click", function () {
          S.chosen[id] = parseInt(btn.getAttribute("data-i"), 10); S.ms = S.ms || {}; S.ms[id] = Math.round(performance.now() - start);
          qb.querySelectorAll(".opt").forEach(function (x) { x.setAttribute("aria-pressed", x === btn ? "true" : "false"); });
          sb.rpc("pl_answer", { p_token: S.token, p_answers: [{ item: id, choice: S.chosen[id], ms: S.ms[id] }] }).then(function () {}, function () {});
        });
      });
    });
    if (listening) bindAudio(p, plays);
    $("#nx").addEventListener("click", function () { stopAudio(); submitAll(); });
    setTimer(function () { return S.blockDl - performance.now(); });
    S.onTick = function () { if (performance.now() >= S.blockDl) { stopAudio(); submitAll(); } };
  }
  function stopAudio() { try { if (S.audio) { S.audio.pause(); S.audio = null; } if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {} }
  function bindAudio(p, plays) {
    var btn = $("#play"), info = $("#playInfo"), playing = false;
    function done() { playing = false; btn.disabled = S.plays >= plays; }
    btn.addEventListener("click", function () {
      if (playing || S.plays >= plays) return;
      S.plays++; playing = true; btn.disabled = true; info.textContent = S.plays + " / " + plays;
      if (p.audio_path) {
        S.audio = new Audio(cfg.url + "/storage/v1/object/public/placement-audio/" + p.audio_path);
        S.audio.addEventListener("ended", done); S.audio.addEventListener("error", done);
        S.audio.play().catch(done);
      } else if (p.tts && window.speechSynthesis) {            // staff preview only: no recording uploaded yet
        var u = new SpeechSynthesisUtterance(p.tts); u.lang = "en-GB"; u.rate = 0.9; u.onend = done; u.onerror = done; speechSynthesis.speak(u);
      } else done();
    });
  }

  /* ---------- stuck / finish ---------- */
  $("#stuckBtn").addEventListener("click", function () { $("#stuckDlg").showModal(); });
  $("#stuckClose").addEventListener("click", function () { $("#stuckDlg").close(); });
  function collectNow() { return Object.keys(S.chosen || {}).map(function (k) { return { item: k, choice: S.chosen[k], ms: (S.ms && S.ms[k]) || null }; }); }
  $("#endSec").addEventListener("click", function () { $("#stuckDlg").close(); stopAudio(); next(collectNow(), "section"); });
  $("#endWritten").addEventListener("click", function () { $("#stuckDlg").close(); stopAudio(); next(collectNow(), "written"); });

  /* ---------- speaking ---------- */
  function speakIntro() {
    var t = T.speaking;
    dockOn(false); $("#dock").hidden = false;
    screen('<div class="card">' + bi(t.en, t.ar) + '</div>' +
      '<div class="card soft"><div class="label">Check · فحص</div><p id="micMsg">Press to test again. · اضغط للاختبار مرة أخرى.</p><div class="bar"><i id="lvl"></i></div><div style="height:12px"></div>' +
      '<div class="row"><button class="btn secondary" id="micBtn" type="button">Test microphone · اختبر الميكروفون</button><label class="row" style="gap:8px"><input type="checkbox" id="camChk"' + (S.camera ? ' checked' : '') + '> <span>Use my camera (optional) · استخدم الكاميرا (اختياري)</span></label></div>' +
      '<div style="height:12px"></div><video id="prev" class="prev" playsinline muted hidden></video></div>' +
      '<div class="row end"><button class="btn" id="go" type="button" disabled>Start speaking · ابدأ التحدّث</button></div>');
    async function open() {
      closeStream(); S.quiet = Date.now() + 8000; var want = $("#camChk").checked;
      try { S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: want ? { facingMode: "user", width: 640, height: 480 } : false }); S.camera = want && S.stream.getVideoTracks().length > 0; }
      catch (e) { try { S.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); S.camera = false; $("#camChk").checked = false; } catch (e2) { S.stream = null; } }
      if (!S.stream) { $("#micMsg").innerHTML = 'We cannot reach your microphone. Allow it in the browser, or press <b>I need help</b>.<br><span class="ar" dir="rtl">لا نستطيع الوصول إلى الميكروفون.</span>'; return; }
      var v = $("#prev"); if (S.camera) { v.srcObject = S.stream; v.hidden = false; v.play().catch(function () {}); } else v.hidden = true;
      meter($("#lvl")); $("#go").disabled = false; $("#micMsg").innerHTML = '<span class="ok">Ready.</span> · <span class="ok">جاهز.</span>';
    }
    $("#micBtn").addEventListener("click", open); $("#camChk").addEventListener("change", function () { if (S.stream) open(); });
    $("#go").addEventListener("click", async function () {
      if (!S.stream) return; S.busy = false;
      try { S.st = await rpc("pl_next", { p_token: S.token }); } catch (e) { return; }
      render();
    });
    open();
  }
  async function speakRun() {
    var prompts = S.st.prompts || [], rec = S.st.recorded || [];
    var todo = prompts.filter(function (p) { return rec.indexOf(p.slot) < 0; });
    if (!todo.length) return finish();
    dockOn(false); $("#dock").hidden = false;
    if (!S.stream) {
      try { S.quiet = Date.now() + 8000; S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: S.camera ? { facingMode: "user", width: 640, height: 480 } : false }); }
      catch (e) { return speakIntroAgain(); }
    }
    var p = todo[0], n = prompts.indexOf(p) + 1;
    await recordPrompt(p, n, prompts.length);
  }
  function speakIntroAgain() { S.st.intro = true; speakIntro(); }
  function pickMime(video) {
    if (!window.MediaRecorder) return "";
    var c = video ? ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"] : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (var i = 0; i < c.length; i++) if (MediaRecorder.isTypeSupported(c[i])) return c[i];
    return "";
  }
  function recordPrompt(p, n, total) {
    return new Promise(function (resolve) {
      var prep = (p.prep_seconds || 10) * 1000, maxMs = (p.max_seconds || 60) * 1000;
      screen('<div class="card"><div class="label">Task ' + n + ' of ' + total + ' · المهمة ' + n + ' من ' + total + '</div><p class="stem" id="ptxt">' + esc(p.text) + '</p>' +
        '<p id="phase" class="muted">Get ready. Recording starts automatically. · استعد. يبدأ التسجيل تلقائيًا.</p><div class="bar"><i id="lvl"></i></div><div style="height:16px"></div>' +
        (S.camera ? '<video id="prev" class="prev" playsinline muted></video>' : '') +
        '<div class="row end"><span class="rec" id="recTag" hidden><i></i>Recording · يسجّل</span><button class="btn" id="fin" type="button" disabled>Finish · إنهاء</button></div></div>');
      meter($("#lvl"));
      if (S.camera) { var v = $("#prev"); v.srcObject = S.stream; v.play().catch(function () {}); }
      var t0 = performance.now(), mime = pickMime(S.camera), recorder = null, chunks = [], recStart = 0, stopped = false;
      if (!window.MediaRecorder) { return fail("Your browser cannot record. Press I need help. · متصفحك لا يدعم التسجيل. اضغط «أحتاج مساعدة»."); }
      setTimer(function () { return recorder ? (recStart + maxMs - performance.now()) : (t0 + prep - performance.now()); });
      S.onTick = function () {
        var now = performance.now();
        if (!recorder && now >= t0 + prep) start();
        else if (recorder && !stopped && now >= recStart + maxMs) stop();
      };
      function start() {
        try { recorder = mime ? new MediaRecorder(S.stream, { mimeType: mime, audioBitsPerSecond: 64000, videoBitsPerSecond: 500000 }) : new MediaRecorder(S.stream); }
        catch (e) { return fail("Recording could not start. Press I need help. · تعذّر بدء التسجيل."); }
        recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = upload;
        recStart = performance.now(); recorder.start(1000);
        $("#phase").textContent = "Speak now. · تحدّث الآن."; $("#recTag").hidden = false; $("#fin").disabled = false;
      }
      function stop() { if (stopped) return; stopped = true; stopTimer(); try { recorder.stop(); } catch (e) { upload(); } }
      $("#fin").addEventListener("click", stop);
      function fail(m) { stopTimer(); screen('<div class="card"><p>' + esc(m) + '</p></div>'); }
      async function upload() {
        stopTimer();
        var type = (recorder && recorder.mimeType || mime || "audio/webm").split(";")[0];
        var blob = new Blob(chunks, { type: type }), dur = Math.round(performance.now() - recStart);
        var ext = type.indexOf("mp4") >= 0 ? "mp4" : type.indexOf("ogg") >= 0 ? "ogg" : "webm";
        var path = S.token + "/" + p.slot + "-" + Date.now() + "." + ext;
        for (;;) {
          screen('<div class="card soft"><p id="upm">Saving your answer… · جارٍ حفظ إجابتك…</p></div>');
          var ok = false;
          for (var i = 0; i < 3 && !ok; i++) {
            var r = await sb.storage.from("placement").upload(path, blob, { contentType: type, upsert: false });
            if (!r.error || /exists|duplicate/i.test(r.error.message || "")) ok = true; else await sleep(1000 * (i + 1));
          }
          if (ok) {
            try {
              await rpc("pl_record", { p_token: S.token, p_prompt: p.id, p_slot: p.slot, p_path: path, p_mime: type, p_has_video: S.camera, p_duration_ms: dur });
              S.st.recorded = (S.st.recorded || []).concat([p.slot]); resolve(); return speakRun();
            } catch (e) {}
          }
          screen('<div class="card">' + bi('<p>We could not save your answer. Check your internet and try again.</p>', '<p>لم نتمكن من حفظ إجابتك. تحقق من الإنترنت وحاول مرة أخرى.</p>') + '<button class="btn" id="retry" type="button">Try again · حاول مرة أخرى</button></div>');
          await new Promise(function (res) { $("#retry").addEventListener("click", res); });
        }
      }
    });
  }
  async function finish() {
    stopTimer(); var cam = S.camera; closeStream();
    try { await rpc("pl_complete", { p_token: S.token, p_camera: cam }); } catch (e) { return setTimeout(finish, 2500); }
    S.st = { status: "submitted", stage: 4 }; flush(); S.noGate = true;
    if (inFs()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
    render();
  }

  /* ---------- thank you ---------- */
  function thanks() {
    stopTimer(); S.noGate = true; $("#gate").classList.remove("on"); dockOn(false); $("#dock").hidden = false;
    $("#mistakeBtn").hidden = false;
    screen('<div class="card">' + bi(
      '<h1>Thank you!</h1><p>Your test is complete. A teacher will listen to your speaking, then send your result and recommended plan to your WhatsApp.</p><p>If you pressed Finish by mistake, use the <b>I need help</b> button below and tell us.</p>',
      '<h1>شكرًا لك!</h1><p>لقد أنهيت الاختبار. سيستمع معلّم إلى تحدّثك ثم يرسل لك نتيجتك والخطة المقترحة على واتساب.</p><p>إذا ضغطت «إنهاء» بالخطأ فاستخدم زر <b>أحتاج مساعدة</b> في الأسفل وأخبرنا.</p>') + '</div>');
  }

  /* ---------- help ---------- */
  var dlg = $("#helpDlg");
  function helpCall(kind, note) {
    return sb.rpc("pl_help", { p_token: S.token || null, p_lead: S.lead || null, p_kind: kind, p_section: S.st ? S.st.section : null, p_note: note || null });
  }
  $("#helpBtn").addEventListener("click", function () {
    $("#helpMsg").textContent = ""; $("#waBtn").href = "https://wa.me/" + WA + "?text=" + encodeURIComponent("Hello CLEAR, I need help with the online placement test.");
    dlg.showModal();
  });
  $("#waBtn").addEventListener("click", function () { S.quiet = Date.now() + 30000; helpCall("whatsapp"); });
  $("#cbBtn").addEventListener("click", async function () {
    var r = await helpCall("callback");
    $("#helpMsg").textContent = r.error ? "Please use WhatsApp. · من فضلك استخدم واتساب." : "Thank you. We will call you back. · شكرًا، سنتصل بك.";
  });
  $("#mistakeBtn").addEventListener("click", async function () {
    var r = await helpCall("submitted_by_mistake");
    $("#helpMsg").textContent = r.error ? "Please use WhatsApp. · من فضلك استخدم واتساب." : "Noted. We will reopen your test and contact you. · تم التسجيل. سنعيد فتح اختبارك ونتواصل معك.";
  });
  $("#helpClose").addEventListener("click", function () { dlg.close(); });

  window.addEventListener("pagehide", flush);
  boot();
})();
