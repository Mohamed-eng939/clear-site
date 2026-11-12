/* CLEAR app: Teachers. Admin side: profiles, students, weekly availability, schedule, monitoring, requests, warnings.
   Teacher side: own week, attendance, homework feedback, requests. Plugs into app.js through window.CLEAR_TC.
   Teachers never write to tables directly: every teacher action is a database function that checks the teacher owns the row. */
(function () {
  "use strict";
  var FB_HOURS = 48;            // homework feedback is "late" after this many hours
  var TST = { invited: "Invited", active: "Active", paused: "Paused", ended: "Ended" };
  var REQK = { leave: "Time off", swap: "Swap a lesson", material: "Materials", suggestion: "Suggestion", other: "Other" };
  var REQS = { open: "Open", approved: "Approved", declined: "Declined", done: "Done" };
  var WARN = { verbal: "Verbal", written: "Written", final: "Final" };
  var DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MARKS = { completed: "Delivered", no_show: "Student no-show", late_cancel: "Late cancel by student", moved: "Moved" };
  var T = { loaded: false, loading: false, teachers: [], links: [], slots: [], reqs: [], warns: [], notes: {}, lessons: [], hw: [], students: [], roster: [], me: null, curLessons: [], curFiles: [], afiles: [] };

  function A() { return window.__clear.api(); }
  function E(s) { return A().esc(s); }
  function byId(list, id) { return list.filter(function (x) { return x.id === id; })[0]; }
  function dt(iso) { return iso ? A().fmtDT(iso) : "—"; }
  function day(iso) { return iso ? String(iso).slice(0, 10) : "—"; }
  function pill(t, c) { return '<span class="pill' + (c ? " " + c : "") + '">' + E(t) + "</span>"; }
  function opts(map, sel) { return Object.keys(map).map(function (k) { return '<option value="' + E(k) + '"' + (k === sel ? " selected" : "") + ">" + E(map[k]) + "</option>"; }).join(""); }
  function hoursSince(iso) { return (Date.now() - new Date(iso).getTime()) / 3600000; }
  function nz(v) { return v === "" || v == null ? null : v; }
  function num(v) { return v === "" || v == null ? null : Number(v); }
  function fld(id, label, input, wide) { return '<div class="f' + (wide ? " wide" : "") + '"><label for="' + id + '">' + E(label) + "</label>" + input + "</div>"; }
  function inp(id, name, val, type, extra) { return '<input id="' + id + '" name="' + name + '" type="' + (type || "text") + '" value="' + E(val == null ? "" : val) + '"' + (extra || "") + ">"; }
  function ta(id, name, val, h) { return '<textarea id="' + id + '" name="' + name + '"' + (h ? ' style="min-height:' + h + 'px"' : "") + ">" + E(val || "") + "</textarea>"; }
  function studentName(id) { var s = byId(T.students, id) || byId(T.roster, id); return s ? s.full_name : "Student"; }

  /* ------------------------------------------------------------ loading */
  function admin() { return window.__clear.role && window.__clear.role() === "admin"; }
  function load(force) {
    if (T.loading || (T.loaded && !force)) return;
    T.loading = true;
    var a = A(), sb = a.sb, isAdmin = admin();
    var q = function (p) { return Promise.resolve(p).then(function (r) { return r.error ? [] : (r.data || []); }, function () { return []; }); };
    var jobs = isAdmin ? [
      q(sb.from("teachers").select("*").order("created_at", { ascending: true })),
      q(sb.from("teacher_students").select("*")),
      q(sb.from("teacher_slots").select("*").order("dow").order("start_time")),
      q(sb.from("teacher_requests").select("*").order("created_at", { ascending: false })),
      q(sb.from("teacher_warnings").select("*").order("issued_on", { ascending: false })),
      q(sb.from("teacher_notes").select("*")),
      q(sb.from("lessons").select("id,student_id,teacher_id,starts_at,duration_min,status,topic,marked_at,cur_lesson_id").not("teacher_id", "is", null).order("starts_at", { ascending: true })),
      q(sb.from("assignments").select("id,student_id,title,status,submitted_at,reviewed_at,feedback,reviewed_by_teacher")),
      q(sb.from("students").select("id,full_name,status"))
    ] : [
      q(sb.from("teachers").select("*")),
      q(sb.from("teacher_students").select("*")),
      q(sb.from("teacher_slots").select("*").order("dow").order("start_time")),
      q(sb.from("teacher_requests").select("*").order("created_at", { ascending: false })),
      q(sb.from("teacher_warnings").select("*").order("issued_on", { ascending: false })),
      q(sb.from("teacher_roster").select("*")),
      q(sb.from("lessons").select("*").order("starts_at", { ascending: true })),
      q(sb.from("assignments").select("*").order("created_at", { ascending: false })),
      q(sb.from("assignment_files").select("*").order("created_at", { ascending: true })),
      q(sb.from("cur_lessons").select("id,title,objective,grammar,vocabulary,plan,homework,teacher_notes")),
      q(sb.from("cur_files").select("*"))
    ];
    Promise.all(jobs).then(function (r) {
      T.teachers = r[0]; T.links = r[1]; T.slots = r[2]; T.reqs = r[3]; T.warns = r[4];
      if (isAdmin) {
        T.notes = {}; r[5].forEach(function (n) { T.notes[n.teacher_id] = n.body; });
        T.lessons = r[6]; T.hw = r[7]; T.students = r[8];
      } else {
        T.me = r[0][0] || null; T.roster = r[5]; T.lessons = r[6]; T.hw = r[7]; T.afiles = r[8]; T.curLessons = r[9]; T.curFiles = r[10];
      }
      T.loaded = true; T.loading = false; a.render();
    }).catch(function (e) { T.loading = false; a.toast(e.message || "Could not load teachers.", true); });
  }
  function reload() { T.loaded = false; T.loading = false; load(true); }

  /* ------------------------------------------------------------ shared pieces */
  function activeLinks(tid) { return T.links.filter(function (l) { return l.teacher_id === tid && !l.ends_on; }); }
  function teacherLessons(tid) { return T.lessons.filter(function (l) { return l.teacher_id === tid; }); }
  function unmarked(tid) { var now = Date.now(); return teacherLessons(tid).filter(function (l) { return l.status === "scheduled" && new Date(l.starts_at).getTime() + l.duration_min * 60000 < now; }); }
  function waitingHw(tid) {
    var ids = activeLinks(tid).map(function (l) { return l.student_id; });
    return T.hw.filter(function (h) { return h.status === "submitted" && ids.indexOf(h.student_id) >= 0; });
  }
  function overdueHw(tid) { return waitingHw(tid).filter(function (h) { return h.submitted_at && hoursSince(h.submitted_at) > FB_HOURS; }); }
  function openReqs(tid) { return T.reqs.filter(function (r) { return (!tid || r.teacher_id === tid) && r.status === "open"; }); }
  function unackWarns(tid) { return T.warns.filter(function (w) { return w.teacher_id === tid && !w.acknowledged_at; }); }
  function badge() { return admin() ? openReqs().length : 0; }
  function lessonTeacherSelect(l) {
    if (!T.loaded || !T.teachers.length) return "";
    return '<div class="f" style="max-width:260px"><label for="lt_' + l.id + '">Teacher</label><select id="lt_' + l.id + '" data-change="lteacher" data-id="' + l.id + '"><option value="">No teacher</option>' +
      T.teachers.filter(function (t) { return t.status !== "ended"; }).map(function (t) {
        var cur = T.lessons.filter(function (x) { return x.id === l.id; })[0];
        return '<option value="' + t.id + '"' + (cur && cur.teacher_id === t.id ? " selected" : "") + ">" + E(t.full_name) + "</option>";
      }).join("") + "</select></div>";
  }
  function lessonCard(l, forTeacher) {
    var cl = l.cur_lesson_id ? byId(T.curLessons, l.cur_lesson_id) : null;
    var past = new Date(l.starts_at).getTime() + l.duration_min * 60000 < Date.now();
    var st = l.status === "scheduled" ? (past ? pill("Not marked yet", "warn") : pill("Scheduled")) : pill(MARKS[l.status] || l.status, l.status === "completed" ? "ok" : "");
    var who = forTeacher ? studentName(l.student_id) : studentName(l.student_id);
    var h = '<div class="card" style="margin-bottom:8px"><div class="l1"><span class="t">' + E(dt(l.starts_at)) + " · " + E(who) + '</span><span class="pills">' + st + "</span></div>";
    if (forTeacher) {
      h += '<span class="hint">' + E(l.duration_min) + " min" + (cl ? " · Plan: " + E(cl.title) : "") + (l.topic ? " · " + E(l.topic) : "") + "</span>";
      if (cl) h += kitBlock(cl);
      if (l.status === "scheduled" && (past || new Date(l.starts_at).getTime() - Date.now() < 3600000)) {
        h += '<form data-form="tc_mark" data-id="' + l.id + '"><div class="fields">' +
          fld("mk" + l.id, "What happened", '<select id="mk' + l.id + '" name="status">' + opts(MARKS, "completed") + "</select>") +
          fld("mt" + l.id, "What you covered (the student sees this)", ta("mt" + l.id, "summary", "", 60), true) +
          '</div><div class="acts" style="margin-top:8px"><button class="btn sm" type="submit">Save</button></div></form>';
      }
    } else h += '<span class="hint">' + E(l.duration_min) + " min" + (l.topic ? " · " + E(l.topic) : "") + "</span>";
    return h + "</div>";
  }
  function kitBlock(cl) {
    var files = T.curFiles.filter(function (f) { return f.lesson_id === cl.id; });
    return '<details style="margin-top:6px"><summary class="hint" style="cursor:pointer">Lesson plan and files: ' + E(cl.title) + "</summary>" +
      (cl.objective ? "<p><b>Objective:</b> " + E(cl.objective) + "</p>" : "") + (cl.plan ? '<p style="white-space:pre-wrap">' + E(cl.plan) + "</p>" : "") +
      (cl.teacher_notes ? '<p style="white-space:pre-wrap"><b>Teacher notes:</b> ' + E(cl.teacher_notes) + "</p>" : "") +
      (files.length ? '<div class="acts" style="flex-wrap:wrap">' + files.map(function (f) { return '<button type="button" class="btn sec sm" data-act="tc_open" data-v="' + E(f.file_path) + '">' + E(f.title || f.file_name) + "</button>"; }).join("") + "</div>" : "") +
      "</details>";
  }

  /* ------------------------------------------------------------ admin: list and profile */
  function adminList() {
    var rows = T.teachers.map(function (t) {
      var flags = [];
      var n = activeLinks(t.id).length; flags.push(pill(n + (n === 1 ? " student" : " students")));
      var o = openReqs(t.id).length; if (o) flags.push(pill(o + " request" + (o > 1 ? "s" : ""), "warn"));
      var d = overdueHw(t.id).length; if (d) flags.push(pill(d + " late feedback", "warn"));
      var u = unmarked(t.id).length; if (u) flags.push(pill(u + " unmarked lesson" + (u > 1 ? "s" : ""), "warn"));
      var w = unackWarns(t.id).length; if (w) flags.push(pill(w + " warning not acknowledged", "warn"));
      return '<div class="card"><div class="l1"><span class="t">' + E(t.full_name) + '</span><span class="pills">' + pill(TST[t.status] || t.status, t.status === "active" ? "ok" : "") + "</span></div>" +
        '<span class="hint">' + E(t.email) + (t.agreement ? " · " + E(t.agreement) : "") + '</span><div class="pills">' + flags.join("") + "</div>" +
        '<div class="acts"><button type="button" class="btn sm" data-act="tc_open_t" data-id="' + t.id + '">Open</button></div></div>';
    }).join("");
    return '<div class="panel"><div><h2>Teachers</h2><p class="hint">Freelance teachers. A teacher sees only the students you assign, never their phone, email or payments. Feedback is marked late after ' + FB_HOURS + " hours.</p></div>" +
      '<div class="cards">' + (rows || '<p class="hint">No teachers yet. Add the first one below.</p>') + "</div>" +
      '<div class="sec"><h3>Add a teacher</h3><form data-form="tc_add" class="addbox"><div class="fields">' +
      fld("ta1", "Full name", inp("ta1", "full_name", "", "text", " required")) + fld("ta2", "Email (their sign-in)", inp("ta2", "email", "", "email", " required")) +
      fld("ta3", "Phone", inp("ta3", "phone", "")) + fld("ta4", "Start date", inp("ta4", "start_date", "", "date")) +
      fld("ta5", "Rate per lesson", inp("ta5", "rate_per_lesson", "", "number", ' step="0.01" min="0"')) + fld("ta6", "Currency", inp("ta6", "currency", "EGP")) +
      fld("ta7", "Hours per week (agreed)", inp("ta7", "weekly_hours", "", "number", ' step="0.5" min="0"')) +
      fld("ta8", "The deal in plain words", inp("ta8", "agreement", "", "text", ' placeholder="Sunday 1 h and Wednesday 1 h"'), true) +
      '</div><div class="acts"><button class="btn" type="submit">Add teacher</button></div></form>' +
      '<p class="hint">After you add them, they sign in at this same address with their email, and the account links by itself. They are an "Invited" teacher until then.</p></div></div>';
  }

  function adminProfile(id) {
    var t = byId(T.teachers, id);
    if (!t) return '<div class="empty"><b>Teacher not found</b><button type="button" class="btn sec sm" data-act="tc_back">Back to teachers</button></div>';
    var links = activeLinks(id);
    var free = T.students.filter(function (s) { return s.status !== "inactive" && s.status !== "completed" && !T.links.some(function (l) { return l.student_id === s.id && !l.ends_on; }); });
    var slots = T.slots.filter(function (s) { return s.teacher_id === id; });
    var lessons = teacherLessons(id);
    var now = Date.now(), upcoming = lessons.filter(function (l) { return l.status === "scheduled" && new Date(l.starts_at).getTime() >= now - 3600000 && new Date(l.starts_at).getTime() < now + 14 * 86400000; });
    var lost = unmarked(id);
    var since = now - 30 * 86400000, recent = lessons.filter(function (l) { return new Date(l.starts_at).getTime() >= since && new Date(l.starts_at).getTime() < now; });
    var done = recent.filter(function (l) { return l.status === "completed"; }).length;
    var reviewed = T.hw.filter(function (h) { return h.reviewed_by_teacher === id && h.reviewed_at && h.submitted_at && new Date(h.reviewed_at).getTime() >= since; });
    var avgH = reviewed.length ? Math.round(reviewed.reduce(function (s, h) { return s + (new Date(h.reviewed_at) - new Date(h.submitted_at)) / 3600000; }, 0) / reviewed.length) : null;
    var wait = waitingHw(id);
    var reqs = T.reqs.filter(function (r) { return r.teacher_id === id; });
    var warns = T.warns.filter(function (w) { return w.teacher_id === id; });
    var h = '<div class="panel"><div class="acts noprint"><button type="button" class="btn sec sm" data-act="tc_back">All teachers</button></div>' +
      '<div><h2>' + E(t.full_name) + '</h2><span class="pills">' + pill(TST[t.status], t.status === "active" ? "ok" : "") + (t.user_id ? pill("Has signed in", "ok") : pill("Not signed in yet", "warn")) + "</span></div>";
    // monitoring
    h += '<div class="sum" style="margin:0"><div><span class="label">Delivered, last 30 days</span><b>' + done + " / " + recent.length + '</b></div><div><span class="label">Unmarked lessons</span><b>' + lost.length + '</b></div><div><span class="label">Homework waiting</span><b>' + wait.length + '</b></div><div><span class="label">Late feedback</span><b>' + overdueHw(id).length + '</b></div><div><span class="label">Avg feedback time</span><b>' + (avgH == null ? "—" : avgH + " h") + "</b></div></div>";
    h += '<div class="sec"><h3>Profile and agreement</h3><form data-form="tc_save" data-id="' + id + '"><div class="fields">' +
      fld("tp1", "Full name", inp("tp1", "full_name", t.full_name, "text", " required")) + fld("tp2", "Email (their sign-in)", inp("tp2", "email", t.email, "email", " required")) +
      fld("tp3", "Phone", inp("tp3", "phone", t.phone)) + fld("tp4", "Status", '<select id="tp4" name="status">' + opts(TST, t.status) + "</select>") +
      fld("tp5", "Start date", inp("tp5", "start_date", t.start_date, "date")) + fld("tp6", "End date", inp("tp6", "end_date", t.end_date, "date")) +
      fld("tp7", "Rate per lesson", inp("tp7", "rate_per_lesson", t.rate_per_lesson, "number", ' step="0.01" min="0"')) + fld("tp8", "Currency", inp("tp8", "currency", t.currency || "EGP")) +
      fld("tp9", "Hours per week (agreed)", inp("tp9", "weekly_hours", t.weekly_hours, "number", ' step="0.5" min="0"')) +
      fld("tp10", "The deal in plain words", inp("tp10", "agreement", t.agreement), true) + fld("tp11", "About them (they can see this)", ta("tp11", "bio", t.bio, 70), true) +
      '</div><div class="acts" style="margin-top:10px"><button class="btn" type="submit">Save</button></div></form></div>';
    // students
    h += '<div class="sec"><h3>Students</h3><div class="cards">' + (links.map(function (l) {
      return '<div class="card"><div class="l1"><span class="t">' + E(studentName(l.student_id)) + '</span><span class="hint">since ' + E(day(l.starts_on)) + '</span></div><div class="acts"><button type="button" class="btn danger sm" data-act="tc_unassign" data-id="' + l.id + '">Remove from this teacher</button></div></div>';
    }).join("") || '<p class="hint">No students assigned.</p>') + "</div>" +
      (free.length ? '<form data-form="tc_assign" data-id="' + id + '" class="addbox"><div class="fields">' + fld("as1", "Assign a student", '<select id="as1" name="student_id">' + free.map(function (s) { return '<option value="' + s.id + '">' + E(s.full_name) + "</option>"; }).join("") + "</select>") +
        '<div class="f"><label><input type="checkbox" name="lessons" value="1" checked> Also give this teacher the student\'s upcoming lessons</label></div></div><div class="acts"><button class="btn" type="submit">Assign</button></div></form>' : '<p class="hint">Every active student already has a teacher.</p>') + "</div>";
    // schedule
    h += '<div class="sec"><h3>Schedule: next 14 days</h3>' + (upcoming.map(function (l) { return lessonCard(l, false); }).join("") || '<p class="hint">No lessons scheduled for this teacher. Give them lessons by assigning a student, or pick the teacher on a lesson in the Lessons tab.</p>') +
      (lost.length ? '<p class="hint" style="color:var(--warn)">' + lost.length + " past lesson" + (lost.length > 1 ? "s" : "") + " not marked by the teacher yet.</p>" : "") + "</div>";
    // booking
    h += '<div class="sec"><h3>Book lessons for a student</h3>' + (links.length ? '<form data-form="tc_book" data-id="' + id + '" class="addbox"><div class="fields">' +
      fld("bk1", "Student", '<select id="bk1" name="student_id">' + links.map(function (l) { return '<option value="' + l.student_id + '">' + E(studentName(l.student_id)) + "</option>"; }).join("") + "</select>") +
      fld("bk2", "Teacher slot", '<select id="bk2" name="slot">' + slots.map(function (sl) { return '<option value="' + sl.id + '">' + E(DOW[sl.dow]) + " " + E(String(sl.start_time).slice(0, 5)) + " (" + sl.duration_min + " min)</option>"; }).join("") + '<option value="custom">Another time</option></select>') +
      fld("bk3", "From date (first lesson falls on the slot's day)", inp("bk3", "from", "", "date", " required")) +
      fld("bk4", "Weeks (one lesson each week)", inp("bk4", "weeks", 4, "number", ' min="1" max="12"')) +
      fld("bk5", "Time, only for \"Another time\" (Egypt)", inp("bk5", "time", "21:00", "time")) + fld("bk6", "Minutes, only for \"Another time\"", inp("bk6", "duration", 60, "number", ' min="15" max="240" step="5"')) +
      '</div><div class="acts"><button class="btn" type="submit">Book lessons</button></div></form><p class="hint">Times are Egypt time. Lessons already booked at the same time are skipped. They use the student\'s current package.</p>' : '<p class="hint">Assign a student first.</p>') + "</div>";
    // availability
    h += '<div class="sec"><h3>Weekly availability (Egypt time)</h3><div class="cards">' + (slots.map(function (s) {
      return '<div class="card"><div class="l1"><span class="t">' + E(DOW[s.dow]) + " " + E(String(s.start_time).slice(0, 5)) + " · " + E(s.duration_min) + ' min</span><button type="button" class="btn danger sm" data-act="tc_delslot" data-id="' + s.id + '">Delete</button></div>' + (s.note ? '<span class="hint">' + E(s.note) + "</span>" : "") + "</div>";
    }).join("") || '<p class="hint">No slots yet.</p>') + '</div><form data-form="tc_slot" data-id="' + id + '" class="addbox"><div class="fields">' +
      fld("sl1", "Day", '<select id="sl1" name="dow">' + DOW.map(function (d, i) { return '<option value="' + i + '">' + d + "</option>"; }).join("") + "</select>") +
      fld("sl2", "Start time", inp("sl2", "start_time", "21:00", "time", " required")) + fld("sl3", "Minutes", inp("sl3", "duration_min", 60, "number", ' min="15" max="240" step="5"')) +
      fld("sl4", "Note", inp("sl4", "note", "")) + '</div><div class="acts"><button class="btn sec" type="submit">Add slot</button></div></form></div>';
    // homework
    h += '<div class="sec"><h3>Homework and feedback</h3>' + (wait.length ? wait.map(function (x) {
      var hrs = x.submitted_at ? Math.round(hoursSince(x.submitted_at)) : 0;
      return '<div class="card"><div class="l1"><span class="t">' + E(x.title) + "</span>" + pill("waiting " + hrs + " h", hrs > FB_HOURS ? "warn" : "") + '</div><span class="hint">' + E(studentName(x.student_id)) + "</span></div>";
    }).join("") : '<p class="hint">Nothing waiting for feedback.</p>') +
      (reviewed.length ? '<p class="label">Recent feedback they gave</p>' + reviewed.slice(-5).reverse().map(function (x) {
        return '<div class="card"><div class="l1"><span class="t">' + E(x.title) + '</span><span class="hint">' + E(studentName(x.student_id)) + '</span></div><p style="white-space:pre-wrap">' + E(x.feedback || "") + "</p></div>";
      }).join("") : "") + "</div>";
    // requests
    h += '<div class="sec"><h3>Requests and suggestions</h3>' + (reqs.map(function (r) {
      return '<div class="card"><div class="l1"><span class="t">' + E(r.subject) + '</span><span class="pills">' + pill(REQK[r.kind]) + pill(REQS[r.status], r.status === "open" ? "warn" : r.status === "approved" ? "ok" : "") + "</span></div>" +
        '<span class="hint">' + E(day(r.created_at)) + (r.date_from ? " · " + E(day(r.date_from)) + (r.date_to ? " to " + E(day(r.date_to)) : "") : "") + "</span>" + (r.body ? '<p style="white-space:pre-wrap">' + E(r.body) + "</p>" : "") +
        '<form data-form="tc_req" data-id="' + r.id + '"><div class="fields">' + fld("rq" + r.id, "Your reply", ta("rq" + r.id, "admin_reply", r.admin_reply, 50), true) +
        fld("rs" + r.id, "Status", '<select id="rs' + r.id + '" name="status">' + opts(REQS, r.status) + "</select>") + '</div><div class="acts" style="margin-top:8px"><button class="btn sm" type="submit">Save reply</button></div></form></div>';
    }).join("") || '<p class="hint">No requests.</p>') + "</div>";
    // warnings
    h += '<div class="sec"><h3>Warnings</h3><div class="cards">' + (warns.map(function (w) {
      return '<div class="card"><div class="l1"><span class="t">' + E(WARN[w.level]) + " warning · " + E(day(w.issued_on)) + '</span>' + pill(w.acknowledged_at ? "Acknowledged " + day(w.acknowledged_at) : "Not acknowledged", w.acknowledged_at ? "ok" : "warn") + '</div><p>' + E(w.reason) + '</p><div class="acts"><button type="button" class="btn danger sm" data-act="tc_delwarn" data-id="' + w.id + '">Delete</button></div></div>';
    }).join("") || '<p class="hint">No warnings.</p>') + '</div><form data-form="tc_warn" data-id="' + id + '" class="addbox"><div class="fields">' +
      fld("w1", "Level", '<select id="w1" name="level">' + opts(WARN, "verbal") + "</select>") + fld("w2", "Date", inp("w2", "issued_on", new Date().toISOString().slice(0, 10), "date")) +
      fld("w3", "What happened and what is expected", ta("w3", "reason", "", 70), true) + '</div><div class="acts"><button class="btn sec" type="submit">Record warning</button></div></form></div>';
    // notes
    h += '<div class="sec"><h3>Private notes</h3><form data-form="tc_notes" data-id="' + id + '">' + fld("tn", "Only you can see these", ta("tn", "body", T.notes[id], 90), true) + '<div class="acts" style="margin-top:8px"><button class="btn sec" type="submit">Save notes</button></div></form></div></div>';
    return h;
  }

  /* ------------------------------------------------------------ teacher portal */
  function portal() {
    if (!T.loaded) { load(); return '<p class="hint" style="padding:40px 0">Loading…</p>'; }
    var t = T.me;
    if (!t) return '<div class="empty" style="margin-top:24px"><b>Your teacher record was not found</b>Please sign in with the email address the academy has for you.</div>';
    var now = Date.now();
    var up = T.lessons.filter(function (l) { return l.status === "scheduled" && new Date(l.starts_at).getTime() >= now - 3600000 && new Date(l.starts_at).getTime() < now + 21 * 86400000; });
    var tomark = T.lessons.filter(function (l) { return l.status === "scheduled" && new Date(l.starts_at).getTime() + l.duration_min * 60000 < now; });
    var hw = T.hw.filter(function (x) { return x.status === "submitted"; });
    var slots = T.slots;
    var h = '<div style="margin-top:20px;display:grid;gap:22px">';
    h += '<div class="sum" style="margin:0"><div><span class="label">Hello</span><b>' + E((t.full_name || "").split(" ")[0]) + '</b></div><div><span class="label">Students</span><b>' + T.roster.length + '</b></div><div><span class="label">Lessons to mark</span><b>' + tomark.length + '</b></div><div><span class="label">Homework to review</span><b>' + hw.length + "</b></div></div>";
    var warns = T.warns.filter(function (w) { return !w.acknowledged_at; });
    if (warns.length) h += '<div class="paydue" role="alert"><b>Notice from the academy</b>' + warns.map(function (w) { return '<span>' + E(WARN[w.level]) + " warning (" + E(day(w.issued_on)) + "): " + E(w.reason) + ' <button type="button" class="btn sm" data-act="tc_ack" data-id="' + w.id + '">I have read this</button></span>'; }).join("") + "</div>";
    h += '<div class="panel"><div class="sec"><h3>Lessons to mark</h3>' + (tomark.length ? tomark.map(function (l) { return lessonCard(l, true); }).join("") : '<p class="hint">All your past lessons are marked. Thank you.</p>') + "</div>" +
      '<div class="sec"><h3>Your next lessons (Egypt time)</h3>' + (up.length ? up.map(function (l) { return lessonCard(l, true); }).join("") : '<p class="hint">No lessons scheduled in the next 3 weeks.</p>') + "</div></div>";
    h += '<div class="panel"><div class="sec"><h3>Homework to review</h3>' + (hw.length ? hw.map(function (x) {
      var files = T.afiles.filter(function (f) { return f.assignment_id === x.id; });
      return '<div class="card"><div class="l1"><span class="t">' + E(x.title) + '</span>' + pill("waiting " + Math.round(hoursSince(x.submitted_at)) + " h", hoursSince(x.submitted_at) > FB_HOURS ? "warn" : "") + '</div><span class="hint">' + E(studentName(x.student_id)) + (x.submitted_at ? " · sent " + E(day(x.submitted_at)) : "") + "</span>" +
        (x.sub_text ? '<div class="receipt">' + E(x.sub_text) + "</div>" : "") +
        (files.length ? '<div class="acts" style="flex-wrap:wrap">' + files.map(function (f) { return '<button type="button" class="btn sec sm" data-act="tc_open" data-v="' + E(f.path) + '">Open: ' + E(f.name) + "</button>"; }).join("") + "</div>" : "") +
        '<form data-form="tc_fb" data-id="' + x.id + '">' + fld("fb" + x.id, "Your feedback to the student", ta("fb" + x.id, "feedback", "", 90), true) + '<div class="acts" style="margin-top:8px"><button class="btn sm" type="submit">Send feedback</button></div></form></div>';
    }).join("") : '<p class="hint">Nothing waiting for feedback.</p>') + "</div>" +
      '<div class="sec"><h3>Give homework</h3>' + (T.roster.length ? '<form data-form="tc_hw" class="addbox"><div class="fields">' +
        fld("hw1", "Student", '<select id="hw1" name="student_id">' + T.roster.map(function (s) { return '<option value="' + s.id + '">' + E(s.full_name) + "</option>"; }).join("") + "</select>") +
        fld("hw2", "Title", inp("hw2", "title", "", "text", " required")) + fld("hw3", "Due date", inp("hw3", "due_on", "", "date")) + fld("hw4", "Instructions", ta("hw4", "instructions", "", 70), true) +
        '</div><div class="acts"><button class="btn" type="submit">Assign</button></div></form>' : '<p class="hint">You will see your students here once the academy assigns them.</p>') + "</div></div>";
    h += '<div class="panel"><div class="sec"><h3>Your students</h3><div class="cards">' + (T.roster.map(function (s) {
      return '<div class="card"><div class="l1"><span class="t">' + E(s.full_name) + '</span><span class="pills">' + (s.level_code ? pill(s.level_code) : "") + (s.cefr ? pill(s.cefr) : "") + "</span></div>" + (s.goal ? '<span class="hint">Goal: ' + E(s.goal) + "</span>" : "") + "</div>";
    }).join("") || '<p class="hint">No students yet.</p>') + "</div></div>" +
      (slots.length ? '<div class="sec"><h3>Your weekly slots</h3><p class="hint">' + slots.map(function (s) { return E(DOW[s.dow]) + " " + E(String(s.start_time).slice(0, 5)) + " (" + E(s.duration_min) + " min)"; }).join(" · ") + "</p></div>" : "") + "</div>";
    h += '<div class="panel"><div class="sec"><h3>Send a request or suggestion</h3><form data-form="tc_send" class="addbox"><div class="fields">' +
      fld("sr1", "Type", '<select id="sr1" name="kind">' + opts(REQK, "suggestion") + "</select>") + fld("sr2", "Subject", inp("sr2", "subject", "", "text", " required")) +
      fld("sr3", "From (if dates matter)", inp("sr3", "date_from", "", "date")) + fld("sr4", "To", inp("sr4", "date_to", "", "date")) + fld("sr5", "Details", ta("sr5", "body", "", 90), true) +
      '</div><div class="acts"><button class="btn" type="submit">Send to the academy</button></div></form></div>' +
      '<div class="sec"><h3>Your requests</h3><div class="cards">' + (T.reqs.map(function (r) {
        return '<div class="card"><div class="l1"><span class="t">' + E(r.subject) + '</span><span class="pills">' + pill(REQK[r.kind]) + pill(REQS[r.status], r.status === "approved" ? "ok" : r.status === "open" ? "warn" : "") + "</span></div>" + (r.admin_reply ? '<div class="receipt"><b>Reply</b>\n' + E(r.admin_reply) + "</div>" : "") + "</div>";
      }).join("") || '<p class="hint">Nothing sent yet.</p>') + "</div></div></div>";
    return h + "</div>";
  }

  /* ------------------------------------------------------------ plug-in points */
  function view(r) {
    if (!T.loaded) { load(); return '<p class="hint" style="padding:40px 0">Loading…</p>'; }
    return r.a ? adminProfile(r.a) : adminList();
  }
  function after(p, msg, done) {
    return A().act(p, msg).then(function () { reload(); }).then(done, done);
  }
  function rpc(name, args, msg, done) {
    return Promise.resolve(A().sb.rpc(name, args)).then(function (res) { if (res.error) throw new Error(res.error.message); A().toast(msg); reload(); }).catch(function (e) { A().toast(e.message || "Could not save.", true); }).then(done, done);
  }
  function click(a, id, v) {
    var sb = A().sb;
    if (a === "tc_open_t") { location.hash = "#/teachers/" + id; return true; }
    if (a === "tc_back") { location.hash = "#/teachers"; return true; }
    if (a === "tc_open") {
      var w = window.open("", "_blank");
      sb.storage.from("materials").createSignedUrl(v, 300).then(function (r) {
        if (r.error || !r.data) { if (w) w.close(); return A().toast("Could not open that file.", true); }
        if (w) { try { w.opener = null; } catch (e) { /* ignore */ } w.location.href = r.data.signedUrl; } else location.href = r.data.signedUrl;
      });
      return true;
    }
    if (a === "tc_ack") { rpc("teacher_ack_warning", { p_id: id }, "Thank you.", function () {}); return true; }
    if (a === "tc_unassign") {
      var l = byId(T.links, id);
      A().ask("Remove this student from the teacher? Their future lessons will have no teacher until you pick one.", "Remove").then(function (ok) {
        if (!ok || !l) return;
        var today = new Date().toISOString().slice(0, 10);
        A().act(sb.from("teacher_students").update({ ends_on: today }).eq("id", id), "Removed.").then(function () {
          return sb.from("lessons").update({ teacher_id: null }).eq("student_id", l.student_id).eq("teacher_id", l.teacher_id).eq("status", "scheduled").gte("starts_at", new Date().toISOString());
        }).then(reload);
      });
      return true;
    }
    if (a === "tc_delslot") { A().act(sb.from("teacher_slots").delete().eq("id", id), "Slot deleted.").then(reload); return true; }
    if (a === "tc_delwarn") { A().ask("Delete this warning record?", "Delete").then(function (ok) { if (ok) A().act(sb.from("teacher_warnings").delete().eq("id", id), "Deleted.").then(reload); }); return true; }
    return false;
  }
  function submit(kind, id, d, done) {
    var sb = A().sb;
    if (kind.indexOf("tc_") !== 0) return false;
    if (kind === "tc_add") { after(sb.from("teachers").insert({ full_name: d.full_name, email: d.email.toLowerCase(), phone: nz(d.phone), start_date: nz(d.start_date), rate_per_lesson: num(d.rate_per_lesson), currency: d.currency || "EGP", weekly_hours: num(d.weekly_hours), agreement: nz(d.agreement) }), "Teacher added.", done); return true; }
    if (kind === "tc_save") { after(sb.from("teachers").update({ full_name: d.full_name, email: d.email.toLowerCase(), phone: nz(d.phone), status: d.status, start_date: nz(d.start_date), end_date: nz(d.end_date), rate_per_lesson: num(d.rate_per_lesson), currency: d.currency || "EGP", weekly_hours: num(d.weekly_hours), agreement: nz(d.agreement), bio: nz(d.bio) }).eq("id", id), "Saved.", done); return true; }
    if (kind === "tc_assign") {
      A().act(sb.from("teacher_students").insert({ teacher_id: id, student_id: d.student_id }), "Assigned.").then(function () {
        if (!d.lessons) return null;
        return sb.from("lessons").update({ teacher_id: id }).eq("student_id", d.student_id).eq("status", "scheduled").gte("starts_at", new Date().toISOString());
      }).then(reload).then(done, done); return true;
    }
    if (kind === "tc_book") { book(id, d, done); return true; }
    if (kind === "tc_slot") { after(sb.from("teacher_slots").insert({ teacher_id: id, dow: Number(d.dow), start_time: d.start_time, duration_min: Number(d.duration_min) || 60, note: nz(d.note) }), "Slot added.", done); return true; }
    if (kind === "tc_req") { after(sb.from("teacher_requests").update({ status: d.status, admin_reply: nz(d.admin_reply), decided_at: d.status === "open" ? null : new Date().toISOString() }).eq("id", id), "Saved.", done); return true; }
    if (kind === "tc_warn") { after(sb.from("teacher_warnings").insert({ teacher_id: id, level: d.level, reason: d.reason, issued_on: d.issued_on || new Date().toISOString().slice(0, 10) }), "Warning recorded.", done); return true; }
    if (kind === "tc_notes") { after(sb.from("teacher_notes").upsert({ teacher_id: id, body: d.body || "", updated_at: new Date().toISOString() }), "Notes saved.", done); return true; }
    if (kind === "tc_mark") { rpc("teacher_mark_lesson", { p_id: id, p_status: d.status, p_topic: null, p_summary: d.summary || null }, "Lesson saved.", done); return true; }
    if (kind === "tc_fb") { rpc("teacher_review_assignment", { p_id: id, p_feedback: d.feedback }, "Feedback sent.", done); return true; }
    if (kind === "tc_hw") { rpc("teacher_assign_homework", { p_student: d.student_id, p_title: d.title, p_instructions: d.instructions || null, p_due: nz(d.due_on) }, "Homework assigned.", done); return true; }
    if (kind === "tc_send") { rpc("teacher_send_request", { p_kind: d.kind, p_subject: d.subject, p_body: d.body || null, p_from: nz(d.date_from), p_to: nz(d.date_to) }, "Sent to the academy.", done); return true; }
    return false;
  }
  function dowOfKey(k) { return new Date(k + "T00:00:00Z").getUTCDay(); }
  function book(tid, d, done) {
    var a = A(), sb = a.sb, slot = d.slot && d.slot !== "custom" ? byId(T.slots, d.slot) : null;
    var time = slot ? String(slot.start_time).slice(0, 5) : d.time, dur = slot ? slot.duration_min : (Number(d.duration) || 60);
    if (!d.from || !time || !d.student_id) { a.toast("Choose a student, a date and a time.", true); return done(); }
    var first = d.from, k = 0;
    if (slot) while (dowOfKey(first) !== slot.dow && k < 7) { first = a.addDays(first, 1); k++; }
    var weeks = Math.max(1, Math.min(12, Number(d.weeks) || 1)), exist = a.lessonsList().concat(T.lessons), pkg = a.activePackage(d.student_id), rows = [], skipped = 0;
    for (var i = 0; i < weeks; i++) {
      var ms = a.zonedToMs(a.addDays(first, 7 * i), time, a.EG);
      var clash = exist.some(function (l) { return l.status === "scheduled" && new Date(l.starts_at).getTime() === ms && (l.student_id === d.student_id || l.teacher_id === tid); });
      if (clash) skipped++; else rows.push({ student_id: d.student_id, teacher_id: tid, package_id: pkg ? pkg.id : null, starts_at: new Date(ms).toISOString(), duration_min: dur });
    }
    if (!rows.length) { a.toast("Those times are already booked.", true); return done(); }
    Promise.resolve(sb.from("lessons").insert(rows).select("id")).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      if (pkg && !pkg.starts_on) { var day = rows[0].starts_at; return sb.from("packages").update({ starts_on: a.dayKey(day), expires_on: a.addDays(a.dayKey(day), 70) }).eq("id", pkg.id); }
    }).then(function () {
      a.toast("Booked " + rows.length + " lesson" + (rows.length > 1 ? "s" : "") + (skipped ? " (" + skipped + " already booked)" : "") + (pkg ? "." : ". The student has no package yet, so they are not counted against one."));
      reload(); return a.refresh();
    }).catch(function (e) { a.toast(e.message || "Could not book.", true); }).then(done, done);
  }
  function change(t, ch) {
    if (ch === "lteacher") {
      var tid = t.value || null;
      A().act(A().sb.from("lessons").update({ teacher_id: tid }).eq("id", t.getAttribute("data-id")).select("id"), "Teacher set.").then(function () { reload(); A().refresh(); });
      return true;
    }
    return false;
  }

  window.CLEAR_TC = { teachersList: function () { return T.teachers.filter(function (t) { return t.status !== "ended"; }); }, teacherName: function (id) { var t = byId(T.teachers, id); return t ? t.full_name : ""; }, view: view, portal: portal, click: click, submit: submit, change: change, badge: badge, ensure: function () { load(); }, lessonTeacherSelect: lessonTeacherSelect, reset: function () { T.loaded = false; T.loading = false; } };
})();
