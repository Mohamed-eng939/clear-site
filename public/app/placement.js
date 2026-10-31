/* CLEAR app: Placement area. Leads, results, speaking review, feedback reports and the question bank.
   Plugs into app.js through window.CLEAR_PL. Nothing here deletes data: items and passages are retired, never removed. */
(function () {
  "use strict";
  var BANDS = ["pre_a1", "a1_1", "a1_2", "a1_3", "a2", "b1", "b2"];
  var BL = { pre_a1: "Pre-A1", a1_1: "A1.1", a1_2: "A1.2", a1_3: "A1.3", a2: "A2", b1: "B1", b2: "B2", custom: "Custom path (above B2)" };
  var LST = { new: "New", test_started: "Test started", test_completed: "Test completed", speaking_reviewed: "Speaking reviewed", report_sent: "Report sent", contacted: "Contacted", booked: "Booked", enrolled: "Enrolled", lost: "Lost" };
  var PROG = { general: "General English", business: "Business English", conversation: "Conversation", esp: "ESP" };
  var SEC = { vocab_grammar: "Vocabulary and grammar", reading: "Reading", listening: "Listening" };
  var CRIT = [["fluency", "Fluency"], ["accuracy", "Accuracy"], ["pronunciation", "Pronunciation"], ["range", "Range of language"]];
  var FLAGK = ["tab_hidden", "fullscreen_exit", "window_blur", "copy", "paste", "context_menu"];
  var P = { loaded: false, loading: false, leads: [], attempts: [], helps: [], evs: [], cfg: null, filter: "all", q: "", d: null,
            bank: { items: [], passages: [], prompts: [] }, bankLoaded: false, bankTab: "items", bf: { section: "all", band: "all", status: "all", q: "" }, edit: null };

  function A() { return window.__clear.api(); }
  function E(s) { return A().esc(s); }
  function byId(list, id) { return list.filter(function (x) { return x.id === id; })[0]; }
  function pill(t, c) { return '<span class="pill' + (c ? " " + c : "") + '">' + E(t) + "</span>"; }
  function dt(iso) { return iso ? A().fmtDT(iso) : "—"; }
  function bandName(b) { return BL[b] || b || "—"; }
  function optList(map, sel, all) { return (all ? '<option value="all">' + E(all) + "</option>" : "") + Object.keys(map).map(function (k) { return '<option value="' + E(k) + '"' + (k === sel ? " selected" : "") + ">" + E(map[k]) + "</option>"; }).join(""); }
  function waLink(phone, text) { return "https://wa.me/" + String(phone || "").replace(/[^0-9]/g, "") + (text ? "?text=" + encodeURIComponent(text) : ""); }
  function lastAttempt(leadId) { return P.attempts.filter(function (a) { return a.lead_id === leadId; })[0] || null; }
  function flagsOf(attId) { return P.evs.filter(function (e) { return e.attempt_id === attId; }).length; }
  function openHelp() { return P.helps.filter(function (h) { return !h.handled; }).length; }

  /* ------------------------------------------------------------ loading */
  function load() {
    if (P.loading) return; P.loading = true;
    var a = A(), sb = a.sb;
    Promise.all([
      sb.from("placement_leads").select("*").order("created_at", { ascending: false }),
      sb.from("placement_attempts").select("id,lead_id,started_at,finished_at,status,stage,band_written,scores,camera_on,submitted_by_mistake,reopened_count,is_test,paper").order("started_at", { ascending: false }),
      sb.from("placement_help_requests").select("*").order("created_at", { ascending: false }),
      sb.from("placement_events").select("attempt_id,kind").in("kind", FLAGK).limit(5000),
      sb.from("placement_thresholds").select("cfg").eq("id", 1).maybeSingle()
    ]).then(function (r) {
      P.leads = a.unwrap(r[0]) || []; P.attempts = a.unwrap(r[1]) || []; P.helps = a.unwrap(r[2]) || []; P.evs = a.unwrap(r[3]) || [];
      var c = a.unwrap(r[4]); P.cfg = c ? c.cfg : null; P.loaded = true; P.loading = false; a.render();
    }).catch(function (e) { P.loading = false; P.loaded = false; a.toast(e.message, true); });
  }
  function loadBank() {
    if (P.bankLoading) return; P.bankLoading = true;
    var a = A(), sb = a.sb;
    Promise.all([
      sb.from("placement_items").select("*").order("code"), sb.from("placement_passages").select("*").order("code"), sb.from("placement_prompts").select("*").order("code")
    ]).then(function (r) {
      P.bank = { items: a.unwrap(r[0]) || [], passages: a.unwrap(r[1]) || [], prompts: a.unwrap(r[2]) || [] }; P.bankLoaded = true; P.bankLoading = false; a.render();
    }).catch(function (e) { P.bankLoading = false; a.toast(e.message, true); });
  }
  async function loadDetail(att) {
    var a = A(), sb = a.sb; P.d = { id: att.id, loading: true };
    try {
      var r = await Promise.all([
        sb.from("placement_responses").select("*").eq("attempt_id", att.id).order("answered_at"),
        sb.from("placement_recordings").select("*").eq("attempt_id", att.id).order("slot"),
        sb.from("placement_events").select("*").eq("attempt_id", att.id).order("at"),
        sb.from("placement_feedback").select("*").eq("attempt_id", att.id).order("created_at", { ascending: false }).limit(1)
      ]);
      var resp = a.unwrap(r[0]) || [], recs = a.unwrap(r[1]) || [], evs = a.unwrap(r[2]) || [], fb = (a.unwrap(r[3]) || [])[0] || null;
      var served = []; ((att.paper && att.paper.served) || []).forEach(function (b) { (b.ids || []).forEach(function (i) { served.push(i); }); });
      var items = {}, prompts = {}, scores = [];
      if (served.length) (a.unwrap(await sb.from("placement_items").select("id,code,band,section,stem,options,correct_index").in("id", served)) || []).forEach(function (i) { items[i.id] = i; });
      var pids = recs.map(function (x) { return x.prompt_id; }).filter(Boolean);
      if (pids.length) (a.unwrap(await sb.from("placement_prompts").select("id,text,slot").in("id", pids)) || []).forEach(function (p) { prompts[p.id] = p; });
      if (fb) scores = a.unwrap(await sb.from("placement_feedback_scores").select("*").eq("feedback_id", fb.id)) || [];
      await Promise.all(recs.map(function (x) {
        return sb.storage.from("placement").createSignedUrl(x.storage_path, 3600).then(function (u) { x.url = u && u.data ? u.data.signedUrl : null; });
      }));
      P.d = { id: att.id, resp: resp, recs: recs, evs: evs, fb: fb, items: items, prompts: prompts, scores: scores, served: served };
    } catch (e) { P.d = { id: att.id, error: e.message }; a.toast(e.message, true); }
    a.render();
  }
  function reloadAll() { P.loaded = false; P.bankLoaded = false; P.d = null; load(); }

  /* ------------------------------------------------------------ shell */
  function tabs(cur) {
    var items = [["", "Pipeline"], ["bank", "Question bank"], ["help", "Help inbox" + (openHelp() ? " (" + openHelp() + ")" : "")], ["settings", "Settings and preview"]];
    return '<div class="tabs noprint" role="group" aria-label="Placement sections" style="margin:18px 0 6px">' + items.map(function (t) {
      return '<button type="button" data-act="plgo" data-v="' + t[0] + '" aria-pressed="' + (cur === t[0]) + '">' + E(t[1]) + "</button>";
    }).join("") + "</div>";
  }
  function view(r) {
    var a = r.a || "";
    if (!P.loaded) { load(); return '<p class="hint" style="padding:30px 0">Loading placement data…</p>'; }
    if (a === "report") return viewReport(r.b);
    var body;
    if (a === "lead") body = viewLead(r.b);
    else if (a === "bank") body = viewBank();
    else if (a === "help") body = viewHelp();
    else if (a === "settings") body = viewSettings();
    else body = viewPipeline();
    return tabs(a === "lead" ? "" : a) + body;
  }

  /* ------------------------------------------------------------ pipeline */
  function viewPipeline() {
    var real = P.leads.filter(function (l) { return !l.is_test; });
    var n = function (st) { return real.filter(function (l) { return l.status === st; }).length; };
    var sum = '<div class="sum"><div><span class="label">New enquiries</span><b>' + n("new") + '</b></div><div><span class="label">Waiting for your review</span><b>' + n("test_completed") + '</b></div><div><span class="label">Reviewed, report not sent</span><b>' + n("speaking_reviewed") + '</b></div><div><span class="label">Open help requests</span><b>' + openHelp() + "</b></div></div>";
    var q = P.q.trim().toLowerCase();
    var list = real.filter(function (l) { return (P.filter === "all" || l.status === P.filter) && (!q || (l.full_name + " " + l.phone + " " + (l.src || "")).toLowerCase().indexOf(q) >= 0); });
    var rows = list.map(function (l) {
      var at = lastAttempt(l.id), fl = at ? flagsOf(at.id) : 0, hp = P.helps.filter(function (h) { return h.lead_id === l.id && !h.handled; }).length;
      return '<button type="button" class="row" data-act="plopen" data-id="' + l.id + '"><span class="l1"><span class="nm">' + E(l.full_name) + "</span>" + pill(LST[l.status] || l.status, l.status === "test_completed" ? "warn" : (l.status === "enrolled" ? "ok" : "")) + "</span>" +
        '<span class="meta">' + E(l.phone) + " · " + (l.path === "online" ? "Online test" : "Meeting") + (l.src ? " · from " + E(l.src) : "") + " · " + E(dt(l.created_at)) + "</span>" +
        '<span class="pills">' + (at && at.band_written ? pill("Written: " + bandName(at.band_written), "ok") : "") + (at && at.status === "submitted" ? pill("Submitted") : (at ? pill("In progress", "warn") : "")) +
        (fl ? pill(fl + " integrity signal" + (fl > 1 ? "s" : ""), "warn") : "") + (hp ? pill(hp + " help request" + (hp > 1 ? "s" : ""), "warn") : "") + (at && at.submitted_by_mistake ? pill("Finished by mistake", "warn") : "") + "</span></button>";
    }).join("");
    return sum + '<div class="tools" style="margin-bottom:12px"><input type="search" id="plq" placeholder="Search name, phone or source" aria-label="Search leads" value="' + E(P.q) + '">' +
      '<select data-change="plfilter" aria-label="Filter by status">' + optList(LST, P.filter, "All statuses") + "</select></div>" +
      (rows ? '<div class="list">' + rows + "</div>" : '<div class="empty"><b>No enquiries here yet</b>Every website form and every online test lands in this list.</div>');
  }

  /* ------------------------------------------------------------ one lead */
  function viewLead(leadId) {
    var l = byId(P.leads, leadId); if (!l) return '<div class="empty"><b>Not found</b>This enquiry is not in the list.</div>';
    var at = lastAttempt(l.id);
    if (at && (!P.d || P.d.id !== at.id)) loadDetail(at);
    var d = at && P.d && P.d.id === at.id ? P.d : null;
    var head = '<button type="button" class="btn sec sm noprint" data-act="plgo" data-v="">← All enquiries</button>' +
      '<div class="panel" style="margin-top:12px"><div><h2>' + E(l.full_name) + "</h2><p class=\"hint\">" + E(l.phone) + (l.email ? " · " + E(l.email) : "") + (l.country ? " · " + E(l.country) : "") + " · " + (l.path === "online" ? "Online placement test" : "Meeting path") + (l.src ? " · from " + E(l.src) : "") + "</p>" +
      '<p class="hint">' + (l.program ? E(PROG[l.program] || l.program) : "No program chosen") + (l.package_levels ? ", " + l.package_levels + " level" + (l.package_levels > 1 ? "s" : "") : "") + (l.goal ? " · Goal: " + E(l.goal) : "") + (l.availability ? " · Available: " + E(l.availability) : "") + "</p>" +
      '<p class="hint">Consent: ' + (l.consent_at ? "given " + E(dt(l.consent_at)) : "none") + (l.consent_withdrawn_at ? " · <b>withdrawn " + E(dt(l.consent_withdrawn_at)) + " (exclude from training)</b>" : "") + "</p></div>" +
      '<div class="pills noprint"><a class="btn sm" target="_blank" rel="noopener" href="' + waLink(l.phone, "Hello " + l.full_name.split(" ")[0] + ", this is CLEAR English Academy.") + '">WhatsApp</a>' +
      (l.student_id ? '<a class="btn sec sm" href="#/students/' + l.student_id + '">Open student</a>' : '<button type="button" class="btn sec sm" data-act="plstudent" data-id="' + l.id + '">Make a student from this</button>') + "</div>" +
      '<div class="fields noprint"><div class="f"><label for="lst">Status</label><select id="lst" data-change="plstatus" data-id="' + l.id + '">' + optList(LST, l.status) + "</select></div></div>" +
      '<form data-form="plnote" data-id="' + l.id + '" class="noprint"><div class="f"><label for="pln">Private note</label><textarea id="pln" name="note" rows="2">' + E(l.admin_note || "") + '</textarea></div><div style="margin-top:8px"><button class="btn sm" type="submit">Save note</button></div></form></div>';
    if (!at) return head + '<p class="hint" style="margin-top:14px">' + (l.path === "online" ? "They have not opened the test yet." : "This enquiry chose a meeting, so there is no test to review.") + "</p>";
    if (!d || d.loading) return head + '<p class="hint" style="padding:20px 0">Loading the test…</p>';
    if (d.error) return head + '<p class="err">' + E(d.error) + "</p>";
    return head + resultPanel(l, at, d) + integrityPanel(at, d) + mistakesPanel(d) + speakingPanel(l, at, d);
  }
  function resultPanel(l, at, d) {
    var sc = at.scores || null, rows = "";
    if (sc && sc.bands) rows = BANDS.map(function (b) {
      var x = sc.bands[b] || {};
      return "<tr><td>" + E(bandName(b)) + "</td><td>" + (x.n || 0) + "</td><td>" + (x.correct || 0) + "</td><td>" + (x.adjusted == null ? "—" : x.adjusted + "%") + "</td></tr>";
    }).join("");
    var secs = sc && sc.sections ? Object.keys(sc.sections).map(function (k) { return pill((SEC[k] || k) + ": " + sc.sections[k].correct + "/" + sc.sections[k].n); }).join(" ") : "";
    var stopped = at.paper && at.paper.stopped ? Object.keys(at.paper.stopped).map(function (k) { return pill((SEC[k] || k) + " ended at " + bandName(at.paper.stopped[k]) + " (all wrong)", "warn"); }).join(" ") : "";
    var skips = at.paper && at.paper.skips && at.paper.skips.length ? at.paper.skips.map(function (s) { return pill("Pressed “I’m stuck” in " + (SEC[s.sec] || s.sec) + (s.scope === "written" ? " (skipped to speaking)" : ""), "warn"); }).join(" ") : "";
    return '<div class="panel" style="margin-top:14px"><div class="sec"><h3>Written result</h3>' +
      (at.band_written ? '<p><b style="font:600 24px/1.2 var(--display)">' + E(bandName(at.band_written)) + '</b> <span class="hint">suggested by the written part; your speaking review decides</span></p>' : '<p class="hint">Not scored yet. ' + (at.status === "submitted" ? "" : "The test is still open.") + "</p>") +
      (rows ? '<table class="pltbl"><thead><tr><th>Band</th><th>Questions</th><th>Correct</th><th>Above guessing</th></tr></thead><tbody>' + rows + "</tbody></table>" : "") +
      '<p class="pills" style="margin-top:10px">' + secs + " " + stopped + " " + skips + "</p>" +
      '<p class="hint">Started ' + E(dt(at.started_at)) + (at.finished_at ? " · finished " + E(dt(at.finished_at)) : "") + (at.camera_on ? " · camera on" : " · camera off") + (at.reopened_count ? " · reopened " + at.reopened_count + "×" : "") + "</p>" +
      '<div class="pills noprint" style="margin-top:8px">' + (at.status === "submitted" ? '<button type="button" class="btn sec sm" data-act="plreopen" data-id="' + at.id + '">Reopen the test</button>' : "") + '<button type="button" class="btn sec sm" data-act="plrescore" data-id="' + at.id + '">Re-score</button></div></div></div>';
  }
  function integrityPanel(at, d) {
    var ev = d.evs || [], c = function (k) { return ev.filter(function (e) { return e.kind === k; }); };
    var away = 0; c("tab_hidden").concat(c("tab_visible")).forEach(function (e) { if (e.kind === "tab_visible" && e.away_ms) away += e.away_ms; });
    var real = function (k) { return c(k).filter(function (e) { return e.detail !== "expected"; }).length; };
    var unavailable = c("fullscreen_unavailable").length;
    var chips = [];
    if (real("tab_hidden")) chips.push(pill("Left the page " + real("tab_hidden") + "× (about " + Math.round(away / 1000) + " s away)", "warn"));
    if (real("fullscreen_exit")) chips.push(pill("Left full screen " + real("fullscreen_exit") + "×", "warn"));
    if (c("window_blur").length) chips.push(pill("Clicked away from the window " + c("window_blur").length + "×", "warn"));
    if (c("copy").length + c("paste").length + c("context_menu").length) chips.push(pill("Copy, paste or right-click tried " + (c("copy").length + c("paste").length + c("context_menu").length) + "×", "warn"));
    if (unavailable) chips.push(pill("Full screen was not available on this device"));
    var det = ev.length ? "<details><summary class=\"hint\">All " + ev.length + " events</summary><div class=\"hint\">" + ev.map(function (e) { return E(dt(e.at)) + " · " + E(e.kind) + (e.section ? " · " + E(SEC[e.section] || e.section) : "") + (e.away_ms ? " · " + Math.round(e.away_ms / 1000) + " s" : "") + (e.detail ? " · " + E(e.detail) : ""); }).join("<br>") + "</div></details>" : "";
    return '<div class="panel" style="margin-top:14px"><div class="sec"><h3>Integrity signals</h3>' + (chips.length ? '<p class="pills">' + chips.join(" ") + "</p>" : '<p class="hint">Nothing unusual was recorded.</p>') +
      '<p class="hint">These are signals, not proof. A phone call, a notification or a flaky connection can cause some of them. Use them together with how the speaking sounds.</p>' + det + "</div></div>";
  }
  function mistakesPanel(d) {
    var by = {}; (d.resp || []).forEach(function (r) { by[r.item_id] = r; });
    var rows = (d.served || []).map(function (id) {
      var it = d.items[id], r = by[id]; if (!it || (r && r.is_correct)) return "";
      return '<tr><td>' + E(bandName(it.band)) + "</td><td>" + E(SEC[it.section] || it.section) + "</td><td>" + E(it.stem) + "</td><td>" + (r ? E(it.options[r.chosen_index]) : "<i>no answer</i>") + "</td><td>" + E(it.options[it.correct_index]) + "</td><td>" + (r && r.misconception ? E(r.misconception) : "") + "</td></tr>";
    }).join("");
    var tags = {}; (d.resp || []).forEach(function (r) { if (r.misconception) tags[r.misconception] = (tags[r.misconception] || 0) + 1; });
    var top = Object.keys(tags).sort(function (a, b) { return tags[b] - tags[a]; }).slice(0, 5).map(function (k) { return pill(k + " ×" + tags[k]); }).join(" ");
    return '<div class="panel" style="margin-top:14px"><div class="sec"><h3>Mistakes</h3>' + (top ? '<p class="pills">' + top + "</p>" : "") +
      (rows ? '<div style="overflow-x:auto"><table class="pltbl"><thead><tr><th>Band</th><th>Section</th><th>Question</th><th>Answered</th><th>Correct</th><th>Pattern</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : '<p class="hint">No mistakes recorded.</p>') + "</div></div>";
  }
  function scoreOf(d, recId, crit) { var s = (d.scores || []).filter(function (x) { return x.recording_id === recId && x.criterion === crit; })[0]; return s ? s.score : ""; }
  function speakingPanel(l, at, d) {
    var fb = d.fb || {};
    var recs = d.recs.length ? d.recs.map(function (x) {
      var p = d.prompts[x.prompt_id];
      var media = !x.url ? '<p class="hint">The file could not be opened.</p>' : (x.has_video ? '<video controls preload="metadata" src="' + E(x.url) + '" style="max-width:100%;width:420px;border-radius:8px"></video>' : '<audio controls preload="metadata" src="' + E(x.url) + '" style="width:100%;max-width:420px"></audio>');
      var sel = CRIT.map(function (c) {
        var v = scoreOf(d, x.id, c[0]);
        return '<div class="f"><label>' + c[1] + '</label><select name="r|' + x.id + "|" + c[0] + '"><option value="">—</option>' + [0, 1, 2, 3, 4, 5].map(function (n) { return '<option value="' + n + '"' + (String(v) === String(n) ? " selected" : "") + ">" + n + "</option>"; }).join("") + "</select></div>";
      }).join("");
      return '<div class="card"><div class="l1"><span class="t">Task ' + x.slot + "</span><span class=\"hint\">" + Math.round((x.duration_ms || 0) / 1000) + " s</span></div><p style=\"margin:0\">" + E(p ? p.text : "") + "</p>" + media + '<div class="fields">' + sel + "</div></div>";
    }).join("") : '<p class="hint">No speaking recordings yet.</p>';
    return '<form data-form="plfeedback" data-id="' + at.id + '" class="panel" style="margin-top:14px"><div class="sec"><h3>Speaking review and feedback</h3><p class="hint">Score each answer from 0 to 5. These scores are saved with the audio and are what the future automatic scoring learns from, so score honestly rather than to match the written result.</p><div class="cards">' + recs + "</div></div>" +
      '<div class="fields"><div class="f"><label for="fbb">Recommended level</label><select id="fbb" name="recommended_band"><option value="">—</option>' + optList(BL, fb.recommended_band) + '</select></div>' +
      '<div class="f"><label for="fbp">Recommended program</label><select id="fbp" name="recommended_program"><option value="">—</option>' + optList(PROG, fb.recommended_program) + '</select></div>' +
      '<div class="f"><label for="fbs">Status</label><select id="fbs" name="status">' + optList({ draft: "Draft", final: "Final" }, fb.status || "draft") + "</select></div></div>" +
      '<div class="f"><label for="fbc">Comments for the learner</label><textarea id="fbc" name="comments" rows="4">' + E(fb.comments || "") + '</textarea></div>' +
      '<div class="f"><label for="fbn">Next step</label><textarea id="fbn" name="next_step" rows="2">' + E(fb.next_step || "") + '</textarea></div>' +
      '<div class="pills noprint"><button class="btn" type="submit">Save feedback</button>' + (fb.id ? '<button type="button" class="btn sec" data-act="plreport" data-id="' + at.id + '">Open the report</button>' : "") + "</div></form>";
  }

  /* ------------------------------------------------------------ report (printable) */
  function viewReport(attId) {
    var at = byId(P.attempts, attId); if (!at) return '<div class="empty"><b>Not found</b></div>';
    var l = byId(P.leads, at.lead_id);
    if (!P.d || P.d.id !== at.id) { loadDetail(at); return '<p class="hint" style="padding:30px 0">Loading the report…</p>'; }
    var d = P.d, fb = d.fb || {}, sc = at.scores || {};
    var avg = CRIT.map(function (c) {
      var v = (d.scores || []).filter(function (x) { return x.criterion === c[0]; }).map(function (x) { return x.score; });
      return [c[1], v.length ? (v.reduce(function (a, b) { return a + b; }, 0) / v.length).toFixed(1) : null];
    });
    var secs = sc.sections ? Object.keys(sc.sections).map(function (k) { return "<tr><td>" + E(SEC[k] || k) + "</td><td>" + sc.sections[k].correct + " of " + sc.sections[k].n + "</td></tr>"; }).join("") : "";
    var msg = "Hello " + (l ? l.full_name.split(" ")[0] : "") + ",\nThis is CLEAR English Academy. Your online placement test is reviewed.\nYour level: " + bandName(fb.recommended_band || at.band_written) + (fb.recommended_program ? "\nRecommended program: " + PROG[fb.recommended_program] : "") + (fb.comments ? "\n\n" + fb.comments : "") + (fb.next_step ? "\n\nNext step: " + fb.next_step : "");
    return '<div class="noprint" style="margin:18px 0 12px"><button type="button" class="btn sec sm" data-act="plopen" data-id="' + (l ? l.id : "") + '">← Back to the test</button> <button type="button" class="btn sm" data-act="print">Print or save as PDF</button> ' +
      (l ? '<a class="btn sm" target="_blank" rel="noopener" href="' + waLink(l.phone, msg) + '" data-act-after="sent">Send on WhatsApp</a> <button type="button" class="btn sec sm" data-act="plsent" data-id="' + l.id + '">Mark report sent</button>' : "") + "</div>" +
      '<article class="plrep"><div class="plhead">' + A().logo() + '<span class="label">Placement report</span></div><h2>' + E(l ? l.full_name : "") + '</h2><p class="hint">' + E(dt(at.finished_at || at.started_at)) + "</p>" +
      '<div class="plbig"><span class="label">Your level</span><b>' + E(bandName(fb.recommended_band || at.band_written)) + "</b>" + (fb.recommended_program ? "<span>" + E(PROG[fb.recommended_program]) + "</span>" : "") + "</div>" +
      '<h3>Written part</h3><table class="pltbl"><tbody>' + secs + "</tbody></table>" +
      '<h3>Speaking</h3>' + (avg.some(function (a) { return a[1]; }) ? '<table class="pltbl"><tbody>' + avg.map(function (a) { return "<tr><td>" + a[0] + "</td><td>" + (a[1] == null ? "—" : a[1] + " out of 5") + "</td></tr>"; }).join("") + "</tbody></table>" : '<p class="hint">Not scored yet.</p>') +
      (fb.comments ? "<h3>Teacher's comments</h3><p>" + E(fb.comments).replace(/\n/g, "<br>") + "</p>" : "") + (fb.next_step ? "<h3>Next step</h3><p>" + E(fb.next_step).replace(/\n/g, "<br>") + "</p>" : "") +
      '<p class="hint" style="margin-top:22px">CLEAR English Academy · clearacademy7@gmail.com · WhatsApp +20 112 022 3509</p></article>';
  }

  /* ------------------------------------------------------------ question bank */
  function viewBank() {
    if (!P.bankLoaded) { loadBank(); return '<p class="hint" style="padding:30px 0">Loading the bank…</p>'; }
    var T = P.bankTab, tabsH = '<div class="tabs noprint" style="margin:6px 0 12px">' + [["items", "Questions"], ["passages", "Texts and clips"], ["prompts", "Speaking prompts"]].map(function (t) {
      return '<button type="button" data-act="plbtab" data-v="' + t[0] + '" aria-pressed="' + (T === t[0]) + '">' + t[1] + "</button>"; }).join("") + "</div>";
    var f = P.bf, q = f.q.trim().toLowerCase(), list;
    var okBand = function (b) { return f.band === "all" || b === f.band; };
    if (T === "items") list = P.bank.items.filter(function (x) { return (f.section === "all" || x.section === f.section) && okBand(x.band) && (f.status === "all" || x.status === f.status) && (!q || (x.code + " " + x.stem).toLowerCase().indexOf(q) >= 0); });
    else if (T === "passages") list = P.bank.passages.filter(function (x) { return (f.section === "all" || x.section === f.section) && okBand(x.band) && (f.status === "all" || x.status === f.status) && (!q || (x.code + " " + (x.title || "")).toLowerCase().indexOf(q) >= 0); });
    else list = P.bank.prompts.filter(function (x) { return (f.status === "all" || x.status === f.status) && (!q || (x.code + " " + x.text).toLowerCase().indexOf(q) >= 0); });
    var counts = ["draft", "approved", "retired"].map(function (s) { return pill(s + ": " + P.bank[T].filter(function (x) { return x.status === s; }).length, s === "approved" ? "ok" : (s === "draft" ? "warn" : "")); }).join(" ");
    var tools = '<div class="tools noprint" style="margin-bottom:10px"><input type="search" id="plbq" placeholder="Search code or text" value="' + E(f.q) + '" aria-label="Search the bank">' +
      (T === "prompts" ? "" : '<select data-change="plbf" data-id="section" aria-label="Section">' + optList(T === "items" ? SEC : { reading: "Reading", listening: "Listening" }, f.section, "All sections") + "</select>") +
      (T === "prompts" ? "" : '<select data-change="plbf" data-id="band" aria-label="Band">' + optList(BL, f.band, "All bands").replace(/<option value="custom".*?<\/option>/, "") + "</select>") +
      '<select data-change="plbf" data-id="status" aria-label="Status">' + optList({ draft: "Draft", approved: "Approved", retired: "Retired" }, f.status, "All statuses") + "</select>" +
      '<button type="button" class="btn sm" data-act="pladd">Add</button><button type="button" class="btn sec sm" data-act="plapprove">Approve drafts shown</button></div>';
    var rows = list.slice(0, 250).map(function (x) {
      var pass = T === "items" && x.passage_id ? byId(P.bank.passages, x.passage_id) : null;
      var main = T === "items" ? x.stem : (T === "passages" ? (x.title || "") + " — " + ((x.body || x.transcript || "").slice(0, 80)) : x.text);
      var meta = T === "items" ? (BL[x.band] + " · " + (SEC[x.section] || x.section) + (pass ? " · " + pass.code : "") + " · shown " + x.times_served + "×" + (x.times_served ? " · " + Math.round(x.times_correct / Math.max(1, x.times_served) * 100) + "% correct" : "")) :
        T === "passages" ? (BL[x.band] + " · " + x.section + (x.section === "listening" ? (x.audio_path ? " · audio ✓" : " · no audio yet") : "")) : ("Task " + x.slot + " · " + BL[x.band_from] + " to " + BL[x.band_to] + " · " + x.max_seconds + " s");
      return '<div class="lrow" style="grid-template-columns:110px minmax(0,1fr) 130px auto"><span class="tm" style="font-size:13px">' + E(x.code) + "</span><span>" + E(main) + '<br><span class="sub">' + E(meta) + '</span></span><select data-change="plbstatus" data-id="' + x.id + '" aria-label="Status of ' + E(x.code) + '">' + optList({ draft: "Draft", approved: "Approved", retired: "Retired" }, x.status) + '</select><button type="button" class="btn sec sm" data-act="pledit" data-id="' + x.id + '">Edit</button></div>';
    }).join("");
    return tabsH + '<p class="pills" style="margin-bottom:10px">' + counts + "</p>" + (P.edit ? editor() : "") + tools +
      (rows ? '<div class="cards">' + rows + "</div>" + (list.length > 250 ? '<p class="hint">Showing the first 250 of ' + list.length + ". Narrow the filter.</p>" : "") : '<div class="empty"><b>Nothing matches</b>Change the filters, or add one.</div>');
  }
  function editor() {
    var e = P.edit, T = P.bankTab, x = e.id ? byId(P.bank[T], e.id) : null;
    var v = function (k, d) { return x && x[k] != null ? x[k] : (d == null ? "" : d); };
    var head = '<form data-form="plbank" data-id="' + (x ? x.id : "") + '" class="panel" style="margin-bottom:14px"><div class="sec"><h3>' + (x ? "Edit " + E(x.code) : "Add") + "</h3>";
    var body = "";
    var common = '<div class="f"><label>Code</label><input name="code" required value="' + E(v("code")) + '"' + (x ? " readonly" : "") + '></div>';
    var stat = '<div class="f"><label>Status</label><select name="status">' + optList({ draft: "Draft", approved: "Approved", retired: "Retired" }, v("status", "draft")) + "</select></div>";
    if (T === "items") {
      var opts = x ? x.options : ["", "", "", ""], mis = x && x.misconceptions ? x.misconceptions : [];
      var passOpts = '<option value="">None (vocabulary and grammar)</option>' + P.bank.passages.map(function (p) { return '<option value="' + p.id + '"' + (x && x.passage_id === p.id ? " selected" : "") + ">" + E(p.code + " · " + (p.title || "")) + "</option>"; }).join("");
      body = '<div class="fields">' + common + '<div class="f"><label>Section</label><select name="section">' + optList(SEC, v("section", "vocab_grammar")) + '</select></div><div class="f"><label>Band</label><select name="band">' + optList(BL, v("band", "a1_1")).replace(/<option value="custom".*?<\/option>/, "") + "</select></div>" + stat + '</div><div class="f"><label>Text or audio it belongs to</label><select name="passage_id">' + passOpts + "</select></div>" +
        '<div class="f"><label>Question (use ____ for a gap)</label><textarea name="stem" rows="2" required>' + E(v("stem")) + "</textarea></div>" +
        [0, 1, 2, 3].map(function (i) { return '<div class="fields"><div class="f"><label>Option ' + "ABCD"[i] + (i < 2 ? "" : " (optional)") + '</label><input name="o' + i + '" value="' + E(opts[i] || "") + '"></div><div class="f"><label>What a learner who picks it is probably doing (hidden from learners)</label><input name="m' + i + '" value="' + E(mis[i] || "") + '"></div></div>'; }).join("") +
        '<div class="fields"><div class="f"><label>Correct option</label><select name="correct">' + ["A", "B", "C", "D"].map(function (l, i) { return '<option value="' + i + '"' + (x && x.correct_index === i ? " selected" : "") + ">" + l + "</option>"; }).join("") + '</select></div><div class="f"><label>Tags (comma separated)</label><input name="tags" value="' + E((x && x.tags || []).join(", ")) + '"></div></div>';
    } else if (T === "passages") {
      body = '<div class="fields">' + common + '<div class="f"><label>Section</label><select name="section">' + optList({ reading: "Reading", listening: "Listening" }, v("section", "reading")) + '</select></div><div class="f"><label>Band</label><select name="band">' + optList(BL, v("band", "a1_1")).replace(/<option value="custom".*?<\/option>/, "") + "</select></div>" + stat + "</div>" +
        '<div class="f"><label>Title</label><input name="title" value="' + E(v("title")) + '"></div><div class="f"><label>Reading text (reading only)</label><textarea name="body" rows="5">' + E(v("body")) + '</textarea></div>' +
        '<div class="f"><label>Transcript (listening only; never shown to learners)</label><textarea name="transcript" rows="4">' + E(v("transcript")) + "</textarea></div>" +
        '<div class="f"><label>Audio clip (listening)</label><input type="file" accept="audio/*" data-change="plaudio" data-id="' + (x ? x.id : "") + '"' + (x ? "" : " disabled") + '><p class="hint">' + (x ? (x.audio_path ? "Current: " + E(x.audio_path) + ". Listen to it before you approve." : "No audio yet. A listening text cannot go live without it.") : "Save the text first, then add its audio.") + "</p>" + (x && x.audio_path ? '<audio controls src="' + E(A().cfgUrl() + "/storage/v1/object/public/placement-audio/" + x.audio_path) + '"></audio>' : "") + "</div>";
    } else {
      body = '<div class="fields">' + common + '<div class="f"><label>Task number</label><select name="slot">' + [1, 2, 3, 4].map(function (n) { return '<option value="' + n + '"' + (v("slot", 1) === n ? " selected" : "") + ">" + n + "</option>"; }).join("") + '</select></div><div class="f"><label>From band</label><select name="band_from">' + optList(BL, v("band_from", "pre_a1")).replace(/<option value="custom".*?<\/option>/, "") + '</select></div><div class="f"><label>To band</label><select name="band_to">' + optList(BL, v("band_to", "b2")).replace(/<option value="custom".*?<\/option>/, "") + "</select></div>" + stat + "</div>" +
        '<div class="f"><label>Prompt</label><textarea name="text" rows="3" required>' + E(v("text")) + '</textarea></div><div class="fields"><div class="f"><label>Thinking seconds</label><input name="prep_seconds" type="number" min="0" max="60" value="' + v("prep_seconds", 10) + '"></div><div class="f"><label>Maximum answer seconds</label><input name="max_seconds" type="number" min="15" max="180" value="' + v("max_seconds", 60) + '"></div></div>';
    }
    return head + body + '<div class="pills"><button class="btn" type="submit">Save</button><button type="button" class="btn sec" data-act="plcancel">Close</button></div><p class="hint">Every edit keeps the previous version. Nothing is ever deleted: retire it instead.</p></div></form>';
  }

  /* ------------------------------------------------------------ help inbox, settings */
  function viewHelp() {
    var rows = P.helps.map(function (h) {
      var l = byId(P.leads, h.lead_id);
      return '<div class="lrow" style="grid-template-columns:130px minmax(0,1fr) auto"><span class="tm" style="font-size:13px">' + E(dt(h.created_at)) + "</span><span><b>" + E(l ? l.full_name : "Unknown") + "</b> · " + E({ whatsapp: "opened WhatsApp", callback: "asked for a call back", submitted_by_mistake: "finished by mistake", other: "other" }[h.kind] || h.kind) + (h.section ? " · " + E(SEC[h.section] || h.section) : "") + (h.note ? '<br><span class="sub">' + E(h.note) + "</span>" : "") + '<br><span class="sub">' + (l ? E(l.phone) : "") + '</span></span><span class="pills">' + (l ? '<a class="btn sec sm" target="_blank" rel="noopener" href="' + waLink(l.phone, "Hello, this is CLEAR English Academy. How can we help?") + '">WhatsApp</a>' : "") + (l ? '<button type="button" class="btn sec sm" data-act="plopen" data-id="' + l.id + '">Open</button>' : "") + '<button type="button" class="btn sm" data-act="plhandled" data-id="' + h.id + '" data-v="' + (h.handled ? "0" : "1") + '">' + (h.handled ? "Reopen" : "Done") + "</button></span></div>";
    }).join("");
    return rows ? '<div class="cards">' + rows + "</div>" : '<div class="empty"><b>No help requests</b>When someone presses “I need help” in the test it appears here.</div>';
  }
  function estimate(c) {
    var v = 0, r = 0, l = 0;
    BANDS.forEach(function (b) { v += (c.vg_items_per_band[b] || 0) * (c.vg_item_seconds[b] || 0); r += c.reading_seconds[b] || 0; l += c.listening_seconds[b] || 0; });
    return { v: v, r: r, l: l, t: v + r + l };
  }
  function viewSettings() {
    var c = P.cfg, est = c ? estimate(c) : null, m = function (s) { return (s / 60).toFixed(1) + " min"; };
    return '<div class="panel"><div class="sec"><h3>Take the test yourself</h3><p class="hint">Opens the learner page in a new tab using draft and approved questions, so you can check the timers, the Arabic instructions and the audio. It is marked as a test and never counts in the pipeline or the statistics.</p><button type="button" class="btn" data-act="plpreview">Preview the test</button></div>' +
      '<form data-form="plcfg" class="sec"><h3>Timing and scoring</h3>' +
      (est ? '<p class="pills">' + pill("Longest possible: " + m(est.t), est.t > 1800 ? "warn" : "ok") + pill("Vocabulary and grammar " + m(est.v)) + pill("Reading " + m(est.r)) + pill("Listening " + m(est.l)) + "</p>" + (est.t > 1800 ? '<p class="err" style="color:var(--warn)">This is over 30 minutes. Lower a timer or the number of questions.</p>' : '<p class="hint">Under 30 minutes even if every timer runs out. Most learners finish sooner, and sections end early when A2 or B1 is all wrong. Speaking is extra.</p>') : "") +
      '<div class="f"><label for="cfgj">Settings (JSON). Seconds per question, questions per band, scoring thresholds, which bands end a section when all answers are wrong.</label><textarea id="cfgj" name="cfg" rows="18" style="font-family:ui-monospace,monospace;font-size:13px">' + E(JSON.stringify(c, null, 2)) + '</textarea></div><div style="margin-top:8px"><button class="btn" type="submit">Save settings</button></div><p class="hint">Changes apply to tests that start after you save. They are kept in the database, so no rebuild is needed.</p></form></div>';
  }

  /* ------------------------------------------------------------ events from app.js */
  function click(a, id, v) {
    if (a.indexOf("pl") !== 0) return false;
    var api = A(), sb = api.sb;
    if (a === "plgo") { location.hash = "#/placement" + (v ? "/" + v : ""); return true; }
    if (a === "plopen") { if (id) location.hash = "#/placement/lead/" + id; return true; }
    if (a === "plreport") { location.hash = "#/placement/report/" + id; return true; }
    if (a === "plbtab") { P.bankTab = v; P.edit = null; P.bf = { section: "all", band: "all", status: "all", q: "" }; api.render(); return true; }
    if (a === "pladd") { P.edit = { id: null }; api.render(); window.scrollTo(0, 0); return true; }
    if (a === "pledit") { P.edit = { id: id }; api.render(); window.scrollTo(0, 0); return true; }
    if (a === "plcancel") { P.edit = null; api.render(); return true; }
    if (a === "plpreview") {
      var w = window.open("", "_blank");
      sb.rpc("pl_preview").then(function (r) { var t = api.unwrap(r); if (w) w.location = "../placement/?t=" + t; else location.href = "../placement/?t=" + t; }, function (e) { if (w) w.close(); api.toast(e.message, true); });
      return true;
    }
    if (a === "plreopen") { api.ask("Reopen this test so the learner can continue? It is counted and kept.", "Reopen").then(function (ok) { if (ok) api.act(sb.rpc("pl_reopen", { p_attempt: id }), "Reopened.").then(reloadAll); }); return true; }
    if (a === "plrescore") { api.act(sb.rpc("pl_rescore", { p_attempt: id }), "Re-scored.").then(reloadAll); return true; }
    if (a === "plhandled") { api.act(sb.from("placement_help_requests").update({ handled: v === "1" }).eq("id", id), "Updated.").then(function () { var h = byId(P.helps, id); if (h) h.handled = v === "1"; api.render(); }); return true; }
    if (a === "plsent") { api.act(sb.from("placement_leads").update({ status: "report_sent", updated_at: new Date().toISOString() }).eq("id", id), "Marked as sent.").then(function () { var l = byId(P.leads, id); if (l) l.status = "report_sent"; api.render(); }); return true; }
    if (a === "plstudent") { makeStudent(id); return true; }
    if (a === "plapprove") { approveShown(); return true; }
    return false;
  }
  function makeStudent(leadId) {
    var api = A(), sb = api.sb, l = byId(P.leads, leadId); if (!l) return;
    var at = lastAttempt(l.id), b = (P.d && P.d.fb && P.d.fb.recommended_band) || (at && at.band_written) || "";
    var cefr = /^a1|pre_a1/.test(b) ? "A1" : (b === "a2" ? "A2" : (b === "b1" ? "B1" : (b === "b2" ? "B2" : null)));
    api.ask("Create a student record for " + l.full_name + "?", "Create").then(function (ok) {
      if (!ok) return;
      api.act(sb.from("students").insert({ full_name: l.full_name, email: l.email, phone: l.phone, country: l.country, program: l.program, cefr: cefr, status: "lead", goal: l.goal }).select().single(), "Student created.").then(function (s) {
        return api.act(sb.from("placement_leads").update({ student_id: s.id, updated_at: new Date().toISOString() }).eq("id", l.id)).then(function () { l.student_id = s.id; return api.refresh(); }).then(function () { location.hash = "#/students/" + s.id; });
      });
    });
  }
  function approveShown() {
    var api = A(), sb = api.sb, T = P.bankTab, f = P.bf, q = f.q.trim().toLowerCase();
    var ids = P.bank[T].filter(function (x) {
      if (x.status !== "draft") return false;
      if (T !== "prompts" && f.section !== "all" && x.section !== f.section) return false;
      if (T !== "prompts" && f.band !== "all" && x.band !== f.band) return false;
      if (f.status !== "all" && x.status !== f.status) return false;
      if (q && (x.code + " " + (x.stem || x.title || x.text || "")).toLowerCase().indexOf(q) < 0) return false;
      if (T === "passages" && x.section === "listening" && !x.audio_path) return false;
      if (T === "items" && x.passage_id) { var p = byId(P.bank.passages, x.passage_id); if (p && p.section === "listening" && !p.audio_path) return false; }
      return true;
    }).map(function (x) { return x.id; });
    if (!ids.length) return api.toast("No drafts to approve here. Listening texts need their audio first.", true);
    api.ask("Approve " + ids.length + " draft" + (ids.length > 1 ? "s" : "") + "? Approved items can be shown to learners.", "Approve").then(function (ok) {
      if (!ok) return;
      var tb = { items: "placement_items", passages: "placement_passages", prompts: "placement_prompts" }[T];
      api.act(sb.from(tb).update({ status: "approved" }).in("id", ids), ids.length + " approved.").then(function () { P.bankLoaded = false; loadBank(); });
    });
  }
  function change(t, ch) {
    if (!ch || ch.indexOf("pl") !== 0) return false;
    var api = A(), sb = api.sb, id = t.getAttribute("data-id");
    if (ch === "plfilter") { P.filter = t.value; api.render(); return true; }
    if (ch === "plbf") { P.bf[id] = t.value; api.render(); return true; }
    if (ch === "plstatus") { api.act(sb.from("placement_leads").update({ status: t.value, updated_at: new Date().toISOString() }).eq("id", id), "Status updated.").then(function () { var l = byId(P.leads, id); if (l) l.status = t.value; api.render(); }); return true; }
    if (ch === "plbstatus") {
      var T = P.bankTab, x = byId(P.bank[T], id), tb = { items: "placement_items", passages: "placement_passages", prompts: "placement_prompts" }[T];
      var pass = T === "items" && x.passage_id ? byId(P.bank.passages, x.passage_id) : (T === "passages" ? x : null);
      if (t.value === "approved" && pass && pass.section === "listening" && !pass.audio_path) { api.toast("Add and listen to the audio before approving a listening text.", true); api.render(); return true; }
      api.act(sb.from(tb).update({ status: t.value }).eq("id", id), "Status updated.").then(function () { x.status = t.value; api.render(); });
      return true;
    }
    if (ch === "plaudio") {
      var file = t.files && t.files[0]; if (!file || !id) return true;
      var ext = (file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, ""), x2 = byId(P.bank.passages, id), path = x2.code + "-v" + (x2.version || 1) + "-" + Date.now() + "." + ext;
      sb.storage.from("placement-audio").upload(path, file, { contentType: file.type || "audio/mpeg", upsert: false }).then(function (r) {
        if (r.error) throw r.error;
        return api.act(sb.from("placement_passages").update({ audio_path: path }).eq("id", id), "Audio saved.");
      }).then(function () { x2.audio_path = path; api.render(); }, function (e) { api.toast(e.message, true); });
      return true;
    }
    return false;
  }
  function input(e) {
    if (e.target.id === "plq") { P.q = e.target.value; var rect = e.target.selectionStart; A().render(); var n = document.getElementById("plq"); if (n) { n.focus(); n.setSelectionRange(rect, rect); } return true; }
    if (e.target.id === "plbq") { P.bf.q = e.target.value; var r2 = e.target.selectionStart; A().render(); var n2 = document.getElementById("plbq"); if (n2) { n2.focus(); n2.setSelectionRange(r2, r2); } return true; }
    return false;
  }
  function submit(kind, id, d, done, form) {
    if (kind.indexOf("pl") !== 0) return false;
    var api = A(), sb = api.sb, nul = api.nul, fin = function () { done(); };
    if (kind === "plnote") { api.act(sb.from("placement_leads").update({ admin_note: nul(d.note), updated_at: new Date().toISOString() }).eq("id", id), "Note saved.").then(function () { var l = byId(P.leads, id); if (l) l.admin_note = d.note; }).then(fin, fin); return true; }
    if (kind === "plcfg") {
      var c; try { c = JSON.parse(d.cfg); } catch (e) { api.toast("That is not valid JSON.", true); fin(); return true; }
      var need = ["vg_items_per_band", "vg_item_seconds", "reading_seconds", "listening_seconds", "stop_all_wrong_bands", "hold_min", "below_min", "min_items", "cooldown_days", "grace_seconds", "listen_plays", "max_leads_per_phone_per_day"];
      var miss = need.filter(function (k) { return c[k] == null; }); if (miss.length) { api.toast("Missing: " + miss.join(", "), true); fin(); return true; }
      api.act(sb.from("placement_thresholds").update({ cfg: c }).eq("id", 1), "Settings saved.").then(function () { P.cfg = c; api.render(); }).then(fin, fin); return true;
    }
    if (kind === "plfeedback") { saveFeedback(id, d).then(fin, fin); return true; }
    if (kind === "plbank") { saveBank(id, d).then(fin, fin); return true; }
    return false;
  }
  async function saveFeedback(attId, d) {
    var api = A(), sb = api.sb, fb = P.d && P.d.fb, now = new Date().toISOString();
    var at = byId(P.attempts, attId);
    var payload = { attempt_id: attId, status: d.status || "draft", comments: api.nul(d.comments), recommended_band: api.nul(d.recommended_band), recommended_program: api.nul(d.recommended_program), next_step: api.nul(d.next_step), updated_at: now };
    var row;
    if (fb) row = await api.act(sb.from("placement_feedback").update(payload).eq("id", fb.id).select().single());
    else row = await api.act(sb.from("placement_feedback").insert(payload).select().single());
    var scores = [];
    Object.keys(d).forEach(function (k) { var m = k.split("|"); if (m[0] === "r" && d[k] !== "") scores.push({ feedback_id: row.id, recording_id: m[1], criterion: m[2], score: parseInt(d[k], 10) }); });
    if (scores.length) await api.act(sb.from("placement_feedback_scores").upsert(scores, { onConflict: "feedback_id,recording_id,criterion" }));
    var l = at && byId(P.leads, at.lead_id);
    if (l && payload.status === "final" && (l.status === "test_completed" || l.status === "test_started")) await sb.from("placement_leads").update({ status: "speaking_reviewed", updated_at: now }).eq("id", l.id);
    api.toast("Feedback saved."); P.d = null; reloadAll();
  }
  async function saveBank(id, d) {
    var api = A(), sb = api.sb, T = P.bankTab, nul = api.nul, rec;
    var tb = { items: "placement_items", passages: "placement_passages", prompts: "placement_prompts" }[T];
    if (T === "items") {
      var opts = [], mis = [], corr = null;
      [0, 1, 2, 3].forEach(function (i) { var o = (d["o" + i] || "").trim(); if (!o) return; if (String(i) === String(d.correct)) corr = opts.length; opts.push(o); mis.push(String(i) === String(d.correct) ? null : nul((d["m" + i] || "").trim())); });
      if (opts.length < 2) return api.toast("An item needs at least two options.", true);
      if (corr == null) return api.toast("The correct option is empty. Fill it in or pick another.", true);
      rec = { code: d.code, section: d.section, band: d.band, passage_id: nul(d.passage_id), stem: d.stem, options: opts, correct_index: corr, misconceptions: mis, tags: (d.tags || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean), status: d.status };
      if (rec.section !== "vocab_grammar" && !rec.passage_id) return api.toast("Reading and listening questions must belong to a text or clip.", true);
      var pass = rec.passage_id ? byId(P.bank.passages, rec.passage_id) : null;
      if (rec.status === "approved" && pass && pass.section === "listening" && !pass.audio_path) return api.toast("Add audio to the clip before approving its questions.", true);
    } else if (T === "passages") {
      rec = { code: d.code, section: d.section, band: d.band, title: nul(d.title), body: nul(d.body), transcript: nul(d.transcript), status: d.status };
      var cur = id ? byId(P.bank.passages, id) : null;
      if (rec.status === "approved" && rec.section === "listening" && !(cur && cur.audio_path)) return api.toast("Add and listen to the audio before approving a clip.", true);
    } else {
      rec = { code: d.code, slot: parseInt(d.slot, 10), band_from: d.band_from, band_to: d.band_to, text: d.text, prep_seconds: parseInt(d.prep_seconds, 10) || 10, max_seconds: parseInt(d.max_seconds, 10) || 60, status: d.status };
    }
    if (id) await api.act(sb.from(tb).update(rec).eq("id", id), "Saved. The previous version is kept.");
    else await api.act(sb.from(tb).insert(rec), "Added as " + rec.status + ".");
    P.edit = null; P.bankLoaded = false; loadBank();
  }

  window.CLEAR_PL = { view: view, click: click, change: change, submit: submit, input: input };
})();
