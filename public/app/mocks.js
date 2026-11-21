/* CLEAR app: Mock answer sheet.
   Student: numbered answer boxes only (no third-party question text), saved as she types, each part submitted once.
   Teacher: enter the key once (teacher only), see automatic marks, override, tag error codes, score and indicative band.
   Plugs into app.js through window.CLEAR_MK. */
(function () {
  "use strict";
  var PARTS = [
    { id: "L", name: "Listening 1 to 40", pfx: "L", lo: 1, hi: 40 },
    { id: "R", name: "Reading 1 to 27", pfx: "R", lo: 1, hi: 27 },
    { id: "R3", name: "Reading 28 to 40 (homework)", pfx: "R", lo: 28, hi: 40 }
  ];
  var CODES = { SP: "Spelling or number slip", WL: "Over the word limit", DI: "Fell for a distractor or correction", PA: "Missed a paraphrase", LP: "Lost place in audio or text", VO: "Unknown vocabulary", TM: "Ran out of time", GU: "Guess with no evidence" };
  var LBAND = [[39, 9], [37, 8.5], [35, 8], [32, 7.5], [30, 7], [26, 6.5], [23, 6], [18, 5.5], [16, 5], [13, 4.5], [11, 4]];
  var RBAND = [[40, 9], [39, 8.5], [37, 8], [36, 7.5], [34, 7], [32, 6.5], [30, 6], [27, 5.5], [23, 5], [19, 4.5], [15, 4], [12, 3.5], [9, 3]];
  var MK = { loaded: false, loading: false, keys: [], sheets: [], marks: {}, part: "L", saving: {}, pv: {}, res: {} };
  var LIVE = { id: null, timer: null, ch: null, last: null }, deb = {};

  function A() { return window.__clear.api(); }
  function E(s) { return A().esc(s); }
  function isAdmin() { return window.__clear.realRole() === "admin"; }
  function prev() { return window.__clear.previewing && window.__clear.previewing(); }
  function sheet(id) { var f = function (s) { return s.id === id; }; return MK.sheets.filter(f)[0] || [].concat.apply([], Object.keys(MK.pv).map(function (k) { return MK.pv[k]; })).filter(f)[0]; }
  function keyOf(id) { return MK.keys.filter(function (k) { return k.id === id; })[0]; }
  function opts(map, sel) { return Object.keys(map).map(function (k) { return '<option value="' + E(k) + '"' + (k === sel ? " selected" : "") + ">" + E(k + " · " + map[k]) + "</option>"; }).join(""); }
  function partOf(id) { return PARTS.filter(function (p) { return p.id === id; })[0]; }
  function qkeys(p) { var o = []; for (var n = p.lo; n <= p.hi; n++) o.push(p.pfx + n); return o; }
  function band(table, raw) { for (var i = 0; i < table.length; i++) if (raw >= table[i][0]) return table[i][1]; return null; }
  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim().replace(/[.]+$/, ""); }

  function load(force) {
    if (MK.loading || (MK.loaded && !force)) return;
    MK.loading = true;
    var sb = A().sb, q = function (p) { return Promise.resolve(p).then(function (r) { return r.error ? [] : (r.data || []); }, function () { return []; }); };
    Promise.all([q(sb.from("mock_sheets").select("*").order("created_at", { ascending: false })), isAdmin() ? q(sb.from("mock_keys").select("*")) : Promise.resolve([]), isAdmin() ? q(sb.from("mock_marks").select("*")) : Promise.resolve([])]).then(function (r) {
      MK.sheets = r[0]; MK.keys = r[1]; MK.marks = {}; r[2].forEach(function (m) { MK.marks[m.sheet_id] = m; });
      MK.loaded = true; MK.loading = false;
      if (!document.activeElement || document.activeElement === document.body || !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) A().render();
    }, function () { MK.loading = false; });
  }

  /* ------------------------------------------------------------ marking logic */
  function autoMark(shtKey, a, q) {
    var key = shtKey && shtKey[q]; if (!key) return null;
    var alts = String(key).split("/").map(norm).filter(Boolean); if (!alts.length) return null;
    var got = norm(a && a[q]); if (!got) return false;
    return alts.indexOf(got) >= 0;
  }
  function result(sht, q) {
    var mk = MK.marks[sht.id], ov = mk && mk.overrides && mk.overrides[q];
    if (ov === true || ov === false) return ov;
    var k = keyOf(sht.mock_id); return autoMark(k && k.answers, sht.answers, q);
  }
  function score(sht, p) { var n = 0, marked = 0; qkeys(p).forEach(function (q) { var r = result(sht, q); if (r === true) n++; if (r !== null) marked++; }); return { raw: n, of: p.hi - p.lo + 1, marked: marked }; }
  function summary(sht) {
    var l = score(sht, PARTS[0]), r1 = score(sht, PARTS[1]), r3 = score(sht, PARTS[2]);
    var tally = {}, mk = MK.marks[sht.id]; var codes = (mk && mk.codes) || {};
    Object.keys(codes).forEach(function (q) { if (codes[q] && result(sht, q) === false) tally[codes[q]] = (tally[codes[q]] || 0) + 1; });
    var top = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; }).slice(0, 3).map(function (c) { return c + " ×" + tally[c]; }).join(", ");
    var rAll = r1.raw + r3.raw, r3done = !!(sht.submitted && sht.submitted.R3) || Object.keys(sht.answers || {}).some(function (k) { var n = +k.slice(1); return k[0] === "R" && n >= 28 && sht.answers[k]; });
    var lFull = l.marked === 40, rFull = r1.marked + r3.marked === 40;
    return { l: l, r1: r1, r3: r3, rAll: rAll, r3done: r3done, lFull: lFull, rFull: rFull, lBand: lFull ? band(LBAND, l.raw) : null, rBand: r3done && rFull ? band(RBAND, rAll) : null, top: top };
  }
  function fmtBand(b) { return b == null ? "below the table" : b; }

  /* ------------------------------------------------------------ student side */
  function boxes(sht, p, locked) {
    return '<div class="mk-grid">' + qkeys(p).map(function (q) {
      return '<label class="mk-q"><b>' + q.slice(1) + '</b><input class="mk-box" data-q="' + q + '" data-change="mksave" data-sheet="' + sht.id + '" data-part="' + p.id + '" maxlength="80" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Question ' + q.slice(1) + '" value="' + E((sht.answers || {})[q] || "") + '"' + (locked ? " disabled" : "") + "></label>";
    }).join("") + "</div>";
  }
  function pvSheets(sid) {
    if (!MK.pv[sid]) {
      var real = MK.sheets.filter(function (x) { return x.student_id === sid; }).map(function (x) { return { id: "pv-" + x.id, student_id: sid, title: x.title + " (practice copy)", answers: {}, submitted: {}, __pv: true }; });
      if (!real.length && MK.keys[0]) real = [{ id: "pv-demo", student_id: sid, title: MK.keys[0].title + " (practice copy)", answers: {}, submitted: {}, __pv: true }];
      MK.pv[sid] = real;
    }
    return MK.pv[sid];
  }
  /* the student's own score and band: marked on the server, the key never reaches her browser */
  function anySent(sht) { return !!sht.submitted && Object.keys(sht.submitted).length > 0; }
  function fetchResult(sht) {
    var cur = MK.res[sht.id]; if (cur && (cur.busy || Date.now() - cur.at < 20000)) return;
    MK.res[sht.id] = Object.assign({}, cur || {}, { busy: true, at: cur ? cur.at : 0 });
    Promise.resolve(A().sb.rpc("mock_result", { p_sheet: sht.id })).then(function (r) {
      var old = cur && cur.data; MK.res[sht.id] = { data: r.error ? old || null : r.data, at: Date.now(), busy: false };
      if (JSON.stringify(old || null) !== JSON.stringify(MK.res[sht.id].data) && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || "")) A().render();
    }, function () { MK.res[sht.id] = { data: cur && cur.data, at: Date.now(), busy: false }; });
  }
  function resCell(label, big, small) { return '<div><span class="label">' + label + "</span><b>" + big + "</b>" + (small ? "<small>" + small + "</small>" : "") + "</div>"; }
  function resultHTML(sht) {
    var d, example = sht.__pv;
    if (example) d = { L: { raw: 31, of: 40, band: 7 }, R: { raw: 22, of: 27 }, R3: { raw: 9, of: 13 }, reading: { raw: 31, of: 40, band: 6.5 } };
    else { if (!anySent(sht)) return ""; fetchResult(sht); d = MK.res[sht.id] && MK.res[sht.id].data; if (!d) return '<p class="hint">Getting your result…</p>'; }
    var cells = "", wait = "Your teacher is still preparing the marking. Check again soon.";
    if (d.L) cells += d.L.pending ? resCell("Listening", "·", "marking soon") : resCell("Listening", d.L.raw + " / " + d.L.of, "about band " + fmtBand(d.L.band));
    if (d.reading) cells += d.reading.pending ? resCell("Reading", "·", "marking soon") : resCell("Reading", d.reading.raw + " / " + d.reading.of, "about band " + fmtBand(d.reading.band));
    else {
      if (d.R) cells += d.R.pending ? resCell("Reading 1 to 27", "·", "marking soon") : resCell("Reading 1 to 27", d.R.raw + " / " + d.R.of, "band after Reading 28 to 40");
      if (d.R3) cells += d.R3.pending ? resCell("Reading 28 to 40", "·", "marking soon") : resCell("Reading 28 to 40", d.R3.raw + " / " + d.R3.of, "band after Reading 1 to 27");
    }
    var pending = [d.L, d.R, d.R3, d.reading].some(function (x) { return x && x.pending; });
    return '<div class="mk-result"><h4>' + (example ? "Example of what she will see after sending" : "Your score") + '</h4><div class="sum" style="margin:8px 0">' + cells + "</div>" +
      '<p class="hint">' + (pending ? wait + " " : "") + "Bands are a guide only and can differ a little from a real test. Your teacher will go through your mistakes with you.</p></div>";
  }
  function missing(sht, p) {
    var a = collect(sht.id, p.id); return qkeys(p).filter(function (q) { return !a[q]; });
  }
  function countText(sht, p) { var n = qkeys(p).length - missing(sht, p).length; return n + " of " + qkeys(p).length + " answered"; }
  function studentCard(sid) {
    var list = prev() && sid ? pvSheets(sid) : (isAdmin() ? [] : MK.sheets);
    if (!list.length) return "";
    return '<div class="sec"><h3>Your mock answer sheet</h3><div class="cards">' + list.map(function (sht) {
      var p = partOf(MK.part) || PARTS[0], locked = !!(sht.submitted && sht.submitted[p.id]), have = qkeys(p).filter(function (q) { return ((sht.answers || {})[q] || "").trim(); }).length;
      return '<div class="card"><div class="l1"><span class="t">' + E(sht.title) + '</span><span class="pills">' + PARTS.map(function (x) { return sht.submitted && sht.submitted[x.id] ? '<span class="pill ok">' + E(x.id === "R3" ? "Reading 28-40" : x.name.split(" ")[0] + (x.id === "R" ? " 1-27" : "")) + " sent</span>" : ""; }).join("") + "</span></div>" +
        resultHTML(sht) +
        '<p class="hint">Read the questions in your book or on your printout. Type only your answers here. Spelling counts. Your answers save as you type. Answer every question before you send: if you are not sure, write your best guess.</p>' +
        '<div class="tabs" role="group" aria-label="Part">' + PARTS.map(function (x) { return '<button type="button" data-act="mkpart" data-v="' + x.id + '" aria-pressed="' + (x.id === p.id) + '">' + E(x.name) + "</button>"; }).join("") + "</div>" +
        boxes(sht, p, locked) +
        '<div class="acts"><span class="hint" id="mkstat_' + sht.id + '">' + (locked ? "Sent to your teacher. This part is locked." : have + " of " + qkeys(p).length + " answered") + "</span>" + (locked ? "" : '<button type="button" class="btn" data-act="mksubmit" data-id="' + sht.id + '" data-v="' + p.id + '">Send ' + E(p.name) + "</button>") + "</div></div>";
    }).join("") + "</div></div>";
  }
  function collect(sheetId, partId) {
    var o = {}; Array.prototype.forEach.call(document.querySelectorAll('.mk-box[data-sheet="' + sheetId + '"][data-part="' + partId + '"]'), function (i) { o[i.getAttribute("data-q")] = i.value.trim(); }); return o;
  }
  function stat(id, msg, bad) { var el = document.getElementById("mkstat_" + id); if (el) { el.textContent = msg; el.style.color = bad ? "var(--warn)" : ""; } }
  function save(sheetId, partId, submit) {
    var sht = sheet(sheetId); if (!sht) return Promise.resolve();
    if (sht.__pv) {
      Object.assign(sht.answers, collect(sheetId, partId));
      if (submit) { sht.submitted[partId] = new Date().toISOString(); A().toast("Preview: this part is locked on the practice copy only."); A().render(); } else stat(sheetId, "Saved (practice copy)");
      return Promise.resolve();
    }
    stat(sheetId, "Saving…");
    return Promise.resolve(A().sb.rpc("mock_save", { p_sheet: sheetId, p_answers: collect(sheetId, partId), p_part: partId, p_submit: !!submit })).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      sht.answers = r.data || sht.answers;
      if (submit) { sht.submitted = Object.assign({}, sht.submitted, (function () { var o = {}; o[partId] = new Date().toISOString(); return o; })()); delete MK.res[sheetId]; A().toast("Sent to your teacher."); A().render(); }
      else stat(sheetId, "Saved · " + countText(sht, partOf(partId)));
    }).catch(function (e) { stat(sheetId, e.message || "Could not save. Check your connection.", true); });
  }

  /* ------------------------------------------------------------ admin: panel on the student page */
  function adminPanel(s) {
    if (!isAdmin()) return "";
    load();
    var mine = MK.sheets.filter(function (x) { return x.student_id === s.id; });
    return '<div class="sec"><h3>Mock tests</h3><div class="cards">' + (mine.length ? mine.map(function (x) {
      var sm = summary(x);
      return '<div class="card"><div class="l1"><span class="t">' + E(x.title) + '</span><span class="pills">' + PARTS.map(function (p) { return '<span class="pill ' + (x.submitted && x.submitted[p.id] ? "ok" : "") + '">' + E(p.id === "R3" ? "R 28-40" : p.id === "R" ? "R 1-27" : "L") + (x.submitted && x.submitted[p.id] ? " sent" : "") + "</span>"; }).join("") + "</span></div>" +
        '<span class="hint"><b>Listening</b> ' + sm.l.raw + " / 40" + (sm.lFull ? " · about band " + fmtBand(sm.lBand) : " · key incomplete") + " &nbsp;|&nbsp; <b>Reading</b> " + sm.rAll + " / 40" + (sm.r3done ? (sm.rFull ? " · about band " + fmtBand(sm.rBand) : " · key incomplete") : " · band after Reading 28-40") + "</span>" +
        '<div class="acts"><a class="btn sm" href="#/mock/' + x.id + '">Mark</a><button type="button" class="btn danger sm" data-act="mkdel" data-id="' + x.id + '">Delete</button></div></div>';
    }).join("") : '<p class="hint">No answer sheet yet. Open one and she will see it under My learning.</p>') + "</div>" +
      (MK.keys.length ? '<form data-form="mknew" data-id="' + s.id + '" class="addbox" style="margin-top:10px"><div class="fields"><div class="f wide"><label for="mkk">Mock</label><select id="mkk" name="mock_id">' + MK.keys.map(function (k) { return '<option value="' + E(k.id) + '">' + E(k.title) + "</option>"; }).join("") + '</select></div></div><div class="acts"><button class="btn" type="submit">Open answer sheet for ' + E(s.full_name.split(" ")[0]) + "</button></div></form>" : "") + "</div>";
  }

  /* ------------------------------------------------------------ admin: marking page */
  function view(id) {
    load();
    var sht = sheet(id);
    if (!MK.loaded) return '<p class="hint" style="margin-top:20px">Loading…</p>';
    if (!sht) return '<div class="empty" style="margin-top:20px"><b>Sheet not found</b><a href="#/students">Back to students</a></div>';
    var key = keyOf(sht.mock_id), kans = (key && key.answers) || {}, mk = MK.marks[id] || {}, codes = mk.codes || {};
    var st = (A().students ? A().students() : []).filter(function (x) { return x.id === sht.student_id; })[0];
    var nkeys = Object.keys(kans).filter(function (k) { return kans[k]; }).length;
    var keyGrid = ["L", "R"].map(function (pf) {
      var inputs = ""; for (var n = 1; n <= 40; n++) inputs += '<label class="mk-q"><b>' + n + '</b><input class="mk-box" name="' + pf + n + '" maxlength="80" autocomplete="off" value="' + E(kans[pf + n] || "") + '"></label>';
      return "<h4 style=\"margin:10px 0 6px\">" + (pf === "L" ? "Listening" : "Reading") + '</h4><div class="mk-grid">' + inputs + "</div>";
    }).join("");
    var rows = PARTS.map(function (p) {
      return '<div class="sec"><h3>' + E(p.name) + "</h3>" + (sht.submitted && sht.submitted[p.id] ? "" : '<p class="hint">Not sent by the student yet. You can still mark what she has typed.</p>') +
        '<div class="mk-tbl">' + qkeys(p).map(function (q) {
          var r = result(sht, q), got = (sht.answers || {})[q] || "", ov = mk.overrides && mk.overrides[q];
          return '<div class="mk-row" id="mkr_' + q + '"><b>' + q.slice(1) + '</b><span class="mk-a">' + (got ? E(got) : '<i class="hint">blank</i>') + '</span><span class="mk-k hint">' + E(kans[q] || "no key") + '</span>' +
            '<span class="mk-r" id="mkres_' + q + '">' + (r === null ? "·" : r ? "Right" : "Wrong") + "</span>" +
            '<select data-change="mkov" data-sheet="' + id + '" data-q="' + q + '" aria-label="Mark for question ' + q.slice(1) + '"><option value="">Auto</option><option value="1"' + (ov === true ? " selected" : "") + '>Right</option><option value="0"' + (ov === false ? " selected" : "") + '>Wrong</option></select>' +
            '<select data-change="mkcode" data-sheet="' + id + '" data-q="' + q + '" aria-label="Error code for question ' + q.slice(1) + '"><option value="">Code</option>' + opts(CODES, codes[q]) + "</select></div>";
        }).join("") + "</div></div>";
    }).join("");
    return '<div style="margin-top:18px;display:grid;gap:18px"><div class="acts" style="justify-content:space-between"><a class="btn sec sm" href="#/students/' + sht.student_id + '">&larr; ' + E(st ? st.full_name : "Back to student") + '</a><span class="hint">' + E(sht.title) + '</span></div><div id="mkLive" class="acts" style="gap:10px">' + liveBar(sht) + "</div>" +
      '<div class="panel"><div id="mkSummary">' + summaryHTML(sht) + "</div></div>" +
      '<div class="panel"><details' + (nkeys < 40 ? " open" : "") + '><summary><b>Answer key (teacher only)</b> <span class="hint">' + nkeys + " of 80 entered. Accepted alternatives are separated by a slash, for example <i>colour/color</i>.</span></summary>" +
      '<form data-form="mksavekey" data-id="' + sht.mock_id + '">' + keyGrid + '<div class="acts" style="margin-top:12px"><button class="btn" type="submit">Save key</button></div></form></details></div>' +
      '<div class="panel">' + rows + "</div>" +
      '<div class="panel"><div class="sec"><h3>Notes for the feedback</h3><form data-form="mkcomment" data-id="' + id + '"><textarea name="comment" style="min-height:90px" placeholder="Two strengths, one next move">' + E(mk.comment || "") + '</textarea><div class="acts" style="margin-top:10px"><button class="btn" type="submit">Save notes</button>' +
      PARTS.filter(function (p) { return sht.submitted && sht.submitted[p.id]; }).map(function (p) { return '<button type="button" class="btn sec sm" data-act="mkreopen" data-id="' + id + '" data-v="' + p.id + '">Reopen ' + E(p.id === "R3" ? "Reading 28-40" : p.id === "R" ? "Reading 1-27" : "Listening") + "</button>"; }).join("") + "</div></form></div></div></div>";
  }
  function summaryHTML(sht) {
    var s = summary(sht);
    var cell = function (label, big, small) { return '<div><span class="label">' + label + "</span><b>" + big + "</b>" + (small ? "<small>" + small + "</small>" : "") + "</div>"; };
    return '<div class="sum" style="margin:0">' +
      cell("Listening", s.l.raw + " / 40", s.lFull ? "about band " + fmtBand(s.lBand) : (s.l.marked ? "key has " + s.l.marked + " of 40" : "no key yet")) +
      cell("Reading 1 to 27", s.r1.raw + " / 27", "") +
      cell("Reading 28 to 40", s.r3.raw + " / 13", "") +
      cell("Reading total", s.rAll + " / 40", !s.r3done ? "band after Section 3" : s.rFull ? "about band " + fmtBand(s.rBand) : "key has " + (s.r1.marked + s.r3.marked) + " of 40") +
      cell("Most frequent codes", s.top || "none yet", "") + "</div><p class=\"hint\">Indicative bands only. Say \"about band 6 to 6.5\". They vary a little between test versions.</p>";
  }
  function refreshRow(sht, q) {
    var r = result(sht, q), el = document.getElementById("mkres_" + q); if (el) el.textContent = r === null ? "·" : r ? "Right" : "Wrong";
    var box = document.getElementById("mkSummary"); if (box) box.innerHTML = summaryHTML(sht);
  }
  function upsertMarks(sheetId, patch) {
    var cur = MK.marks[sheetId] || { sheet_id: sheetId, overrides: {}, codes: {}, comment: null };
    var next = Object.assign({}, cur, patch, { updated_at: new Date().toISOString() });
    MK.marks[sheetId] = next;
    return Promise.resolve(A().sb.from("mock_marks").upsert({ sheet_id: sheetId, overrides: next.overrides, codes: next.codes, comment: next.comment, updated_at: next.updated_at })).then(function (r) { if (r.error) throw new Error(r.error.message); });
  }

  /* ------------------------------------------------------------ events */
  function change(t, ch) {
    if (ch === "mksave") { clearTimeout(deb[t.getAttribute("data-sheet") + t.getAttribute("data-part")]); save(t.getAttribute("data-sheet"), t.getAttribute("data-part"), false); return true; }
    if (ch === "mkov" || ch === "mkcode") {
      var id = t.getAttribute("data-sheet"), q = t.getAttribute("data-q"), sht = sheet(id); if (!sht) return true;
      var cur = MK.marks[id] || { overrides: {}, codes: {} }, patch;
      if (ch === "mkov") { var o = Object.assign({}, cur.overrides); if (t.value === "") delete o[q]; else o[q] = t.value === "1"; patch = { overrides: o }; }
      else { var c = Object.assign({}, cur.codes); if (t.value === "") delete c[q]; else c[q] = t.value; patch = { codes: c }; }
      upsertMarks(id, patch).then(function () { refreshRow(sht, q); }).catch(function (e) { A().toast(e.message || "Could not save the mark.", true); });
      return true;
    }
    return false;
  }
  function click(a, id, v) {
    if (a === "mkpart") { MK.part = v; A().render(); return true; }
    if (a === "mksubmit") {
      var p = partOf(v), ms = missing(sheet(id) || { id: id }, p);
      if (ms.length) {
        Array.prototype.forEach.call(document.querySelectorAll('.mk-box[data-sheet="' + id + '"][data-part="' + p.id + '"]'), function (i) { i.closest(".mk-q").classList.toggle("mk-miss", !i.value.trim()); });
        var first = document.querySelector('.mk-box[data-sheet="' + id + '"][data-part="' + p.id + '"][data-q="' + ms[0] + '"]'); if (first) { first.focus(); try { first.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { /* ignore */ } }
        stat(id, "Answer every question before sending. Still blank: " + ms.map(function (q) { return q.slice(1); }).join(", "), true);
        return true;
      }
      A().ask("Send " + p.name + " to your teacher? You cannot change these answers afterwards.", "Send").then(function (ok) { if (ok) save(id, v, true); });
      return true;
    }
    if (a === "mkreopen") {
      var sht = sheet(id); if (!sht) return true;
      var sub = Object.assign({}, sht.submitted); delete sub[v];
      Promise.resolve(A().sb.from("mock_sheets").update({ submitted: sub }).eq("id", id)).then(function (r) { if (r.error) throw new Error(r.error.message); sht.submitted = sub; A().toast("Reopened. The student can edit that part again."); A().render(); }).catch(function (e) { A().toast(e.message || "Could not reopen.", true); });
      return true;
    }
    if (a === "mkdel") {
      A().ask("Delete this answer sheet and its marking? This cannot be undone.", "Delete sheet").then(function (ok) {
        if (!ok) return;
        Promise.resolve(A().sb.from("mock_sheets").delete().eq("id", id)).then(function (r) { if (r.error) throw new Error(r.error.message); MK.sheets = MK.sheets.filter(function (s) { return s.id !== id; }); delete MK.marks[id]; A().toast("Sheet deleted."); A().render(); }).catch(function (e) { A().toast(e.message || "Could not delete.", true); });
      });
      return true;
    }
    return false;
  }
  function submit(kind, id, d, done) {
    var sb = A().sb;
    if (kind === "mknew") {
      var k = keyOf(d.mock_id); if (!k) { done(); return true; }
      Promise.resolve(sb.from("mock_sheets").insert({ student_id: id, mock_id: k.id, title: k.title }).select().single()).then(function (r) { if (r.error) throw new Error(r.error.message); MK.sheets.unshift(r.data); A().toast("Answer sheet opened. She will see it under My learning."); A().render(); }).catch(function (e) { A().toast(e.message || "Could not open it.", true); }).then(done, done);
      return true;
    }
    if (kind === "mksavekey") {
      var ans = {}; Object.keys(d).forEach(function (n) { if (/^[LR]\d{1,2}$/.test(n) && d[n]) ans[n] = d[n]; });
      Promise.resolve(sb.from("mock_keys").update({ answers: ans, updated_at: new Date().toISOString() }).eq("id", id)).then(function (r) { if (r.error) throw new Error(r.error.message); var kk = keyOf(id); if (kk) kk.answers = ans; A().toast("Key saved."); A().render(); }).catch(function (e) { A().toast(e.message || "Could not save the key.", true); }).then(done, done);
      return true;
    }
    if (kind === "mkcomment") {
      upsertMarks(id, { comment: A().nul(d.comment) }).then(function () { A().toast("Notes saved."); }).catch(function (e) { A().toast(e.message || "Could not save.", true); }).then(done, done);
      return true;
    }
    return false;
  }
  function input(e) {
    var t = e.target; if (!t || !t.classList || !t.classList.contains("mk-box") || t.getAttribute("data-change") !== "mksave") return false;
    var sid = t.getAttribute("data-sheet"), part = t.getAttribute("data-part"), k = sid + part;
    if (t.value.trim() && t.closest(".mk-q")) t.closest(".mk-q").classList.remove("mk-miss");
    var sh = sheet(sid), pp = partOf(part);
    clearTimeout(deb[k]); stat(sid, "Typing… " + (sh && pp ? countText(sh, pp) : "")); deb[k] = setTimeout(function () { save(sid, part, false); }, 700);
    return true;
  }
  /* live view: the teacher watches the student's sheet fill in */
  function counts(sht) { var a = sht.answers || {}; return PARTS.map(function (p) { var n = qkeys(p).filter(function (q) { return a[q]; }).length; return (p.id === "L" ? "Listening " : p.id === "R" ? "Reading 1-27 " : "Reading 28-40 ") + n + "/" + (p.hi - p.lo + 1) + (sht.submitted && sht.submitted[p.id] ? " (sent)" : ""); }).join(" · "); }
  function liveBar(sht) { return '<span class="pill ok">Live</span> <span class="hint">' + E(counts(sht)) + (LIVE.last ? " · last change " + E(LIVE.last) : "") + "</span>"; }
  function pull(id) {
    Promise.resolve(A().sb.from("mock_sheets").select("answers,submitted").eq("id", id).maybeSingle()).then(function (r) {
      if (!r || r.error || !r.data) return; var sht = sheet(id); if (!sht || LIVE.id !== id) return;
      var old = sht.answers || {}, nw = r.data.answers || {}, changed = Object.keys(nw).filter(function (k) { return nw[k] !== old[k]; });
      var subChanged = JSON.stringify(sht.submitted || {}) !== JSON.stringify(r.data.submitted || {});
      sht.answers = nw; sht.submitted = r.data.submitted || {};
      changed.forEach(function (q) {
        var row = document.getElementById("mkr_" + q); if (!row) return;
        var cell = row.querySelector(".mk-a"); if (nw[q]) cell.textContent = nw[q]; else cell.innerHTML = '<i class="hint">blank</i>';
        row.classList.add("mk-flash"); setTimeout(function () { row.classList.remove("mk-flash"); }, 2200); refreshRow(sht, q);
      });
      if (changed.length || subChanged) { LIVE.last = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
      var bar = document.getElementById("mkLive"); if (bar) bar.innerHTML = liveBar(sht);
    });
  }
  function stopLive() {
    if (LIVE.timer) clearInterval(LIVE.timer); if (LIVE.ch) { try { A().sb.removeChannel(LIVE.ch); } catch (e) { /* ignore */ } }
    LIVE.id = null; LIVE.timer = null; LIVE.ch = null; LIVE.last = null;
  }
  function startLive(id) {
    if (LIVE.id === id) return; stopLive(); LIVE.id = id;
    LIVE.timer = setInterval(function () { pull(id); }, 3000);
    try { LIVE.ch = A().sb.channel("mk-" + id).on("postgres_changes", { event: "*", schema: "public", table: "mock_sheets", filter: "id=eq." + id }, function () { pull(id); }).subscribe(); } catch (e) { /* polling still runs */ }
    pull(id);
  }
  function after(r) { if (r && r.name === "mock" && r.a && isAdmin() && sheet(r.a)) startLive(r.a); else stopLive(); }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || !e.target || !e.target.classList || !e.target.classList.contains("mk-box")) return;
    e.preventDefault();
    var all = Array.prototype.slice.call(e.target.closest(".mk-grid").querySelectorAll(".mk-box:not([disabled])")), i = all.indexOf(e.target);
    if (all[i + 1]) all[i + 1].focus(); else e.target.blur();
  });

  window.CLEAR_MK = { view: view, adminPanel: adminPanel, studentCard: studentCard, click: click, change: change, input: input, after: after, submit: submit, load: function () { load(); }, reset: function () { MK.loaded = false; MK.loading = false; MK.sheets = []; MK.keys = []; MK.marks = {}; } };
})();
