/* CLEAR app: Books library. Admin only. PDFs (and book audio) kept privately, separate from lessons. Students never see this.
   Plugs into app.js through window.CLEAR_LB. */
(function () {
  "use strict";
  var KINDS = { coursebook: "Coursebook", teachers_book: "Teacher's book", workbook: "Workbook", exam_practice: "Exam practice book", reference: "Reference", audio: "Audio", other: "Other" };
  var MAX = 50 * 1024 * 1024;
  var OK = { pdf: "application/pdf", mp3: "audio/mpeg", m4a: "audio/x-m4a", wav: "audio/wav" };
  var LB = { loaded: false, loading: false, books: [], q: "", kind: "all", edit: null };

  function A() { return window.__clear.api(); }
  function E(s) { return A().esc(s); }
  function byId(id) { return LB.books.filter(function (b) { return b.id === id; })[0]; }
  function size(n) { return !n ? "" : n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10); }
  function opts(map, sel) { return Object.keys(map).map(function (k) { return '<option value="' + E(k) + '"' + (k === sel ? " selected" : "") + ">" + E(map[k]) + "</option>"; }).join(""); }

  function load(force) {
    if (LB.loading || (LB.loaded && !force)) return;
    LB.loading = true;
    Promise.resolve(A().sb.from("library_books").select("*").order("created_at", { ascending: false })).then(function (r) {
      LB.books = r.error ? [] : (r.data || []); LB.loaded = true; LB.loading = false; LB.err = r.error ? r.error.message : null;
      if ((location.hash || "").indexOf("#/library") === 0) A().render();
    }, function () { LB.loading = false; });
  }

  function card(b) {
    var open = LB.edit === b.id;
    return '<div class="card"><div class="l1"><span class="t">' + E(b.title) + '</span><span class="pills"><span class="pill">' + E(KINDS[b.kind] || b.kind) + "</span>" + (b.program ? '<span class="pill">' + E(b.program) + "</span>" : "") + (b.size_bytes ? '<span class="pill">' + size(b.size_bytes) + "</span>" : "") + "</span></div>" +
      '<span class="hint">' + E([b.publisher, b.file_name].filter(Boolean).join(" · ")) + "</span>" + (b.note ? "<p>" + E(b.note) + "</p>" : "") +
      '<div class="acts"><button type="button" class="btn sm" data-act="lbopen" data-id="' + b.id + '">Open</button><button type="button" class="btn sm sec" data-act="lbdl" data-id="' + b.id + '">Download</button><button type="button" class="btn sm sec" data-act="lbedit" data-id="' + b.id + '">' + (open ? "Close" : "Edit details") + '</button><button type="button" class="btn danger sm" data-act="lbdel" data-id="' + b.id + '">Delete</button></div>' +
      (open ? '<form data-form="lbsave" data-id="' + b.id + '" class="addbox"><div class="fields"><div class="f wide"><label for="le1">Title</label><input id="le1" name="title" required value="' + E(b.title) + '"></div>' +
        '<div class="f"><label for="le2">Type</label><select id="le2" name="kind">' + opts(KINDS, b.kind) + '</select></div><div class="f"><label for="le3">Publisher</label><input id="le3" name="publisher" value="' + E(b.publisher || "") + '"></div>' +
        '<div class="f"><label for="le4">Program or level</label><input id="le4" name="program" value="' + E(b.program || "") + '"></div><div class="f wide"><label for="le5">Note</label><textarea id="le5" name="note">' + E(b.note || "") + '</textarea></div></div><div class="acts"><button class="btn" type="submit">Save</button></div></form>' : "") + "</div>";
  }

  function view() {
    load();
    var q = LB.q.toLowerCase();
    var list = LB.books.filter(function (b) { return (LB.kind === "all" || b.kind === LB.kind) && (!q || (b.title + " " + (b.publisher || "") + " " + (b.program || "") + " " + (b.note || "")).toLowerCase().indexOf(q) >= 0); });
    var body = !LB.loaded ? '<p class="hint">Loading…</p>' : LB.err ? '<div class="empty"><b>The Library is not set up yet</b>' + E(LB.err) + "</div>" :
      list.length ? '<div class="cards">' + list.map(card).join("") + "</div>" : '<div class="empty"><b>' + (LB.books.length ? "No book matches" : "No books yet") + "</b>" + (LB.books.length ? "Try another search." : "Add your first PDF below.") + "</div>";
    return '<div style="margin-top:18px;display:grid;gap:18px"><div class="panel"><div><h2>Library</h2><p class="hint">Your books as PDFs, kept apart from the lessons. Only you can see this page. Nothing here is ever sent to a student.</p></div>' +
      '<div class="tools"><input type="search" id="lbq" placeholder="Search title, publisher or level" aria-label="Search books" value="' + E(LB.q) + '"><select data-change="lbkind" aria-label="Filter by type"><option value="all">All types</option>' + opts(KINDS, LB.kind) + "</select></div>" +
      '<div class="sec"><h3>' + list.length + (list.length === 1 ? " book" : " books") + "</h3>" + body + "</div></div>" +
      '<div class="panel"><div class="sec"><h3>Add a book</h3><form data-form="lbadd" class="addbox"><div class="fields">' +
      '<div class="f wide"><label for="la0">File (PDF, or mp3, m4a, wav audio, up to 50 MB)</label><input id="la0" name="file" type="file" accept=".pdf,.mp3,.m4a,.wav,application/pdf,audio/*" required></div>' +
      '<div class="f wide"><label for="la1">Title</label><input id="la1" name="title" placeholder="Leave empty to use the file name"></div>' +
      '<div class="f"><label for="la2">Type</label><select id="la2" name="kind">' + opts(KINDS, "coursebook") + '</select></div><div class="f"><label for="la3">Publisher</label><input id="la3" name="publisher"></div>' +
      '<div class="f"><label for="la4">Program or level</label><input id="la4" name="program" placeholder="e.g. General A1, IELTS GT"></div><div class="f wide"><label for="la5">Note</label><textarea id="la5" name="note"></textarea></div></div>' +
      '<div class="acts"><button class="btn" type="submit">Upload book</button></div></form><p class="hint">A file over 50 MB cannot be uploaded. Split the PDF into two parts (for example units 1 to 6 and 7 to 12) and add each part as its own book.</p></div></div></div>';
  }

  function signed(b, dl) {
    var w = dl ? null : window.open("", "_blank");
    A().sb.storage.from("library").createSignedUrl(b.file_path, 600, dl ? { download: b.file_name } : undefined).then(function (r) {
      if (r.error || !r.data) { if (w) w.close(); return A().toast("Could not open that file. Try again.", true); }
      if (dl) { location.href = r.data.signedUrl; return; }
      if (w) { try { w.opener = null; } catch (e) { /* ignore */ } w.location.href = r.data.signedUrl; } else location.href = r.data.signedUrl;
    }, function () { if (w) w.close(); A().toast("Could not open that file. Try again.", true); });
  }

  function click(a, id) {
    if (a === "lbopen") { var b = byId(id); if (b) signed(b, false); return true; }
    if (a === "lbdl") { var d = byId(id); if (d) signed(d, true); return true; }
    if (a === "lbedit") { LB.edit = LB.edit === id ? null : id; A().render(); return true; }
    if (a === "lbdel") {
      var x = byId(id); if (!x) return true;
      A().ask("Delete \"" + x.title + "\" from the Library? This removes the file and cannot be undone.", "Delete book").then(function (ok) {
        if (!ok) return;
        A().sb.storage.from("library").remove([x.file_path]).then(function () { return A().sb.from("library_books").delete().eq("id", id); }).then(function (r) {
          if (r && r.error) throw new Error(r.error.message);
          LB.books = LB.books.filter(function (y) { return y.id !== id; }); A().toast("Book deleted."); A().render();
        }).catch(function (e) { A().toast(e.message || "Could not delete.", true); });
      });
      return true;
    }
    return false;
  }

  function change(t, ch) {
    if (ch === "lbq") { LB.q = t.value; A().render(); var el = document.getElementById("lbq"); if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* ignore */ } } return true; }
    if (ch === "lbkind") { LB.kind = t.value; A().render(); return true; }
    return false;
  }

  function submit(kind, id, d, done) {
    var sb = A().sb;
    if (kind === "lbsave") {
      sb.from("library_books").update({ title: d.title, kind: d.kind, publisher: A().nul(d.publisher), program: A().nul(d.program), note: A().nul(d.note) }).eq("id", id).select().single().then(function (r) {
        if (r.error) throw new Error(r.error.message);
        LB.books = LB.books.map(function (b) { return b.id === id ? r.data : b; }); LB.edit = null; A().toast("Saved."); A().render();
      }).catch(function (e) { A().toast(e.message || "Could not save.", true); }).then(done, done);
      return true;
    }
    if (kind !== "lbadd") return false;
    var file = d.file;
    if (!file || !file.size) { A().toast("Choose a file from your device first.", true); done(); return true; }
    var ext = (file.name.split(".").pop() || "").toLowerCase(), mime = OK[ext];
    if (!mime) { A().toast("Only PDF or mp3, m4a, wav audio can be added here.", true); done(); return true; }
    if (file.size > MAX) { A().toast("That file is " + size(file.size) + ". The limit is 50 MB. Split the PDF into parts and add each part.", true); done(); return true; }
    var path = uid() + "-" + file.name.replace(/[^\w.\-]+/g, "-");
    A().toast("Uploading " + file.name + "…");
    sb.storage.from("library").upload(path, file, { contentType: mime, upsert: false }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return sb.from("library_books").insert({ title: d.title || file.name.replace(/\.[^.]+$/, ""), kind: d.kind, publisher: A().nul(d.publisher), program: A().nul(d.program), note: A().nul(d.note), file_path: path, file_name: file.name, mime: mime, size_bytes: file.size }).select().single();
    }).then(function (r) {
      if (r.error) { sb.storage.from("library").remove([path]); throw new Error(r.error.message); }
      LB.books.unshift(r.data); A().toast("Book added."); A().render();
    }).catch(function (e) { A().toast(e.message || "Upload failed.", true); }).then(done, done);
    return true;
  }

  window.CLEAR_LB = { view: view, click: click, change: change, input: function (e) { return e.target.id === "lbq" ? change(e.target, "lbq") : false; }, submit: submit, load: function () { load(); }, reset: function () { LB.loaded = false; LB.loading = false; LB.books = []; LB.edit = null; } };
})();
