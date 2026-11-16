/* CLEAR app: Slides. A PowerPoint-like viewer, slide show and editor that runs in the browser.
   Admin and teachers can edit. Students can view and run the slide show, never edit.
   Slides are stored as JSON in public.decks; speaker notes in public.deck_notes (staff only); pictures in public.deck_assets;
   audio files in the private 'materials' bucket under decks/. Plugs into app.js through window.CLEAR_SL. */
(function () {
  "use strict";
  var W = 13.333, H = 7.5, PX = 100;                         // stage is 1333 x 750 px; one inch = 100 px
  var PT = PX / 72;                                          // one point in px
  var PALETTE = ["#16181D", "#E63946", "#FFFFFF", "#F2F3F5", "#6B7280", "#F2A5AB", "#FFD84D", "#A8242F"];
  var AUD_MIME = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav" };
  var SL = { decks: [], loaded: false, loading: false, cache: {}, cur: null, show: null };
  var audio = new Audio(); audio.preload = "auto";
  var mini = null;

  function A() { return window.__clear.api(); }
  function E(s) { return A().esc(s); }
  function isStaff() { var r = window.__clear.role && window.__clear.role(); return r === "admin" || r === "teacher"; }
  function isAdmin() { return window.__clear.role && window.__clear.role() === "admin"; }
  function toast(m, bad) { A().toast(m, bad); }
  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function sid() { return "i" + Math.random().toString(36).slice(2, 9); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }

  /* ------------------------------------------------------------ loading */
  function load(force) {
    if (SL.loading || (SL.loaded && !force)) return;
    SL.loading = true;
    A().sb.from("decks").select("id,cur_lesson_id,title,visible_to_students,updated_at").order("created_at").then(function (r) {
      SL.decks = (r && r.data) || []; SL.loaded = true; SL.loading = false;
      var h = location.hash; if (A().render && !SL.cur && !SL.show) A().render();
    }, function () { SL.loading = false; SL.loaded = true; });
  }
  function deckById(id) { return SL.decks.filter(function (d) { return d.id === id; })[0]; }

  /* ------------------------------------------------------------ rendering a slide */
  function css(o) { return Object.keys(o).map(function (k) { return k + ":" + o[k]; }).join(";"); }
  function itemHTML(it, ctx) {
    var st = { left: it.x * PX + "px", top: it.y * PX + "px", width: it.w * PX + "px", height: it.h * PX + "px" };
    var cls = "sl-it sl-" + it.t, attrs = ' data-id="' + E(it.id) + '"';
    if (it.step) { cls += " sl-step"; attrs += ' data-step="' + it.step + '" data-fx="' + E(it.fx || "fade") + '"'; if (!ctx.all && it.step > ctx.step) cls += " off"; else cls += " on"; }
    if (it.t === "img") {
      var a = ctx.assets[it.src];
      return '<div class="' + cls + '" style="' + css(st) + '"' + attrs + ">" + (a && a.data ? '<img alt="" draggable="false" src="data:' + E(a.mime) + ";base64," + a.data + '">' : '<div class="sl-missing">Picture</div>') + "</div>";
    }
    if (it.t === "audio") {
      var has = it.src && ctx.assets[it.src];
      if (!has && !ctx.edit) return "";
      st.width = Math.max(it.w, 2.6) * PX + "px"; st.height = "60px";
      return '<div class="' + cls + (has ? "" : " sl-aud-empty") + '" style="' + css(st) + '"' + attrs + ">" +
        (has ? '<button type="button" class="sl-aud" data-aud="' + E(it.id) + '" aria-label="Play or pause audio"><span class="sl-aud-ic">&#9654;</span><span class="sl-aud-lb">' + E(it.label || "Listen") + "</span></button>"
          : '<span class="sl-aud-ph">Add audio here: ' + E(it.label || "") + "</span>") + "</div>";
    }
    var ins = it.ins || [0.1, 0.05, 0.1, 0.05];
    st.padding = [ins[1], ins[2], ins[3], ins[0]].map(function (v) { return v * PX + "px"; }).join(" ");
    st["justify-content"] = it.anchor === "m" ? "center" : it.anchor === "b" ? "flex-end" : "flex-start";
    if (it.fill) st.background = it.fill;
    if (it.line) st.border = (it.lw || 1) * PT + "px " + (it.dash ? "dashed " : "solid ") + it.line;
    if (it.shape === "oval") st["border-radius"] = "50%";
    else if (it.shape === "round") st["border-radius"] = (it.rad == null ? 0.1667 : it.rad) * Math.min(it.w, it.h) * PX + "px";
    var ps = (it.paras || []).map(function (p) {
      var pst = { "text-align": p.al === "c" ? "center" : p.al === "r" ? "right" : "left", margin: "0", "line-height": String((p.ls || 1) * 1.2) };
      if (p.sa) pst["margin-bottom"] = p.sa * PT + "px"; if (p.sb) pst["margin-top"] = p.sb * PT + "px";
      var runs = p.runs.map(function (r) {
        var rs = { "font-size": (r.sz || 18) * PT + "px", color: r.c || "#16181D", "font-weight": r.b ? "700" : "400", "font-family": "'" + (r.f || "Source Sans 3") + "',system-ui,sans-serif" };
        if (r.i) rs["font-style"] = "italic";
        return '<span style="' + css(rs) + '">' + E(r.t) + "</span>";
      }).join("");
      return '<p style="' + css(pst) + '">' + (runs || "&nbsp;") + "</p>";
    }).join("");
    return '<div class="' + cls + '" style="' + css(st) + '"' + attrs + ">" + ps + "</div>";
  }
  function stageHTML(slide, ctx) {
    ctx = ctx || {}; ctx.assets = ctx.assets || {}; ctx.step = ctx.step || 0;
    return '<div class="sl-stage" style="background:' + E(slide.bg || "#FFFFFF") + '">' + (slide.items || []).map(function (it) { return itemHTML(it, ctx); }).join("") + "</div>";
  }
  function maxStep(slide) { return (slide.items || []).reduce(function (m, i) { return Math.max(m, i.step || 0); }, 0); }
  /* scale a .sl-fit box (16:9) so the 1333 x 750 stage fits inside it */
  function fit(box) {
    var st = box.firstElementChild; if (!st) return;
    if (!box.clientWidth) { box._tries = (box._tries || 0) + 1; if (box._tries < 20) setTimeout(function () { fit(box); }, 80); return; }
    var s = box.clientWidth / (W * PX); st.style.transform = "scale(" + s + ")";
  }
  function fitAll(root) { $$(".sl-fit", root).forEach(fit); }
  window.addEventListener("resize", function () { fitAll(document); });

  /* ------------------------------------------------------------ opening a deck */
  function open(id, mode, startAt) {
    var a = A(), sb = a.sb, d = deckById(id);
    toast("Opening slides…");
    Promise.all([
      sb.from("decks").select("*").eq("id", id).maybeSingle(),
      sb.from("deck_assets").select("*").eq("deck_id", id),
      isStaff() ? sb.from("deck_notes").select("*").eq("deck_id", id).maybeSingle() : Promise.resolve({ data: null })
    ]).then(function (r) {
      if (!r[0].data) throw new Error("These slides are not available.");
      var as = {}; (r[1].data || []).forEach(function (x) { as[x.id] = x; });
      SL.cur = { id: id, deck: r[0].data, slides: r[0].data.slides || [], notes: (r[2].data && r[2].data.notes) || {}, assets: as, idx: startAt || 0, sel: null, dirty: false, undo: [], mode: mode || "view" };
      if (!SL.cur.slides.length) SL.cur.slides = [blankSlide("Title")];
      mountApp();
      if (mode === "show") startShow();
    }).catch(function (e) { toast(e.message || "Could not open the slides.", true); });
  }

  function blankSlide(title) {
    return { id: "s" + Math.random().toString(36).slice(2, 8), bg: "#FFFFFF", tr: "fade", items: [
      { id: sid(), t: "text", x: 0.6, y: 0.4, w: 12.1, h: 0.8, step: 0, ins: [0.05, 0.03, 0.05, 0.03], anchor: "m", paras: [{ al: "l", runs: [{ t: title || "Title", sz: 32, b: 1, c: "#16181D", f: "Montserrat" }] }] }] };
  }

  /* ------------------------------------------------------------ the app overlay (view and edit) */
  function mountApp() {
    var c = SL.cur, edit = c.mode === "edit" && isStaff();
    var el = $("#slApp"); if (!el) { el = document.createElement("div"); el.id = "slApp"; el.className = "slapp"; document.body.appendChild(el); }
    document.body.classList.add("sl-open");
    el.innerHTML = appHTML(edit);
    fitAll(el); wireApp(el);
  }
  function appHTML(edit) {
    var c = SL.cur;
    var bar = '<div class="sl-bar"><div class="sl-title"><b>' + E(c.deck.title) + '</b><span class="sl-sub">' + (edit ? "Editing" : "Viewing") + (c.dirty ? " · unsaved changes" : "") + "</span></div><div class=\"sl-bar-acts\">" +
      '<button type="button" class="btn sm" data-sl="show">&#9654; Slide show</button>' +
      (isStaff() ? (edit ? '<button type="button" class="btn sm sec" data-sl="undo">Undo</button><button type="button" class="btn sm" data-sl="save"' + (c.dirty ? "" : " disabled") + '>Save</button><button type="button" class="btn sm sec" data-sl="view">Done editing</button>'
        : '<button type="button" class="btn sm sec" data-sl="edit">Edit</button>') : "") +
      '<button type="button" class="btn sm sec" data-sl="close">Close</button></div></div>';
    var thumbs = '<div class="sl-thumbs" id="slThumbs">' + c.slides.map(function (s, i) {
      return '<button type="button" class="sl-th' + (i === c.idx ? " cur" : "") + '" data-sl="goto" data-i="' + i + '" aria-label="Slide ' + (i + 1) + '"><span class="sl-n">' + (i + 1) + '</span><span class="sl-fit">' + stageHTML(s, { assets: c.assets, all: true, edit: edit }) + "</span></button>";
    }).join("") + (edit ? '<div class="sl-th-acts"><button type="button" class="btn sm sec" data-sl="addslide">+ Slide</button><button type="button" class="btn sm sec" data-sl="dupslide">Duplicate</button><button type="button" class="btn sm sec" data-sl="up">&uarr;</button><button type="button" class="btn sm sec" data-sl="down">&darr;</button><button type="button" class="btn sm sec" data-sl="delslide">Delete</button></div>' : "") + "</div>";
    var slide = c.slides[c.idx];
    var main = '<div class="sl-main"><div class="sl-canvas"><div class="sl-fit" id="slCanvas" data-edit="' + (edit ? 1 : 0) + '">' + stageHTML(slide, { assets: c.assets, all: true, edit: edit }) + "</div></div>" +
      '<div class="sl-nav"><button type="button" class="btn sm sec" data-sl="prev">&larr; Previous</button><span>Slide ' + (c.idx + 1) + " of " + c.slides.length + '</span><button type="button" class="btn sm sec" data-sl="next">Next &rarr;</button></div>' +
      (audioBarHTML(slide) || "") + (!edit && isStaff() && c.notes[slide.id] ? '<div class="sl-notes"><b>Teacher notes</b><p>' + E(c.notes[slide.id]) + "</p></div>" : "") + "</div>";
    var props = edit ? '<div class="sl-props" id="slProps">' + propsHTML() + "</div>" : "";
    return bar + '<div class="sl-body' + (edit ? " edit" : "") + '">' + thumbs + main + props + "</div>";
  }
  function audioBarHTML(slide) {
    var list = (slide.items || []).filter(function (i) { return i.t === "audio" && i.src && SL.cur.assets[i.src]; });
    if (!list.length) return "";
    return '<div class="sl-audbar"><b>Audio on this slide</b>' + list.map(function (i) { return '<button type="button" class="btn sm sec" data-aud="' + E(i.id) + '"><span class="sl-aud-ic">&#9654;</span> ' + E(i.label || "Listen") + "</button>"; }).join("") + "</div>";
  }
  function refreshApp(keepProps) {
    var el = $("#slApp"); if (!el || !SL.cur) return;
    var edit = SL.cur.mode === "edit" && isStaff();
    el.innerHTML = appHTML(edit); fitAll(el); wireApp(el); syncAudioUI();
  }

  /* ------------------------------------------------------------ editor: properties panel */
  function selItem() { var c = SL.cur; if (!c || !c.sel) return null; return c.slides[c.idx].items.filter(function (i) { return i.id === c.sel; })[0] || null; }
  function colorSel(name, val, withNone) {
    return '<div class="sl-sw" data-name="' + name + '">' + (withNone ? '<button type="button" class="sw none' + (!val ? " on" : "") + '" data-sl="color" data-name="' + name + '" data-v="" title="None">&times;</button>' : "") +
      PALETTE.map(function (c) { return '<button type="button" class="sw' + (val && val.toLowerCase() === c.toLowerCase() ? " on" : "") + '" style="background:' + c + '" data-sl="color" data-name="' + name + '" data-v="' + c + '" aria-label="' + c + '"></button>'; }).join("") + "</div>";
  }
  function propsHTML() {
    var c = SL.cur, slide = c.slides[c.idx], it = selItem();
    var add = '<div class="sl-add"><b>Add</b><button type="button" class="btn sm sec" data-sl="addtext">Text</button><button type="button" class="btn sm sec" data-sl="addbox">Box</button>' +
      '<label class="btn sm sec">Picture<input type="file" accept="image/*" data-sl-file="img" hidden></label><label class="btn sm sec">Audio<input type="file" accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/wav" data-sl-file="aud" hidden></label></div>';
    var slideP = '<div class="sl-pg"><b>This slide</b><div class="sl-row"><label>Background</label>' + colorSel("bg", slide.bg, false) + "</div>" +
      '<div class="sl-row"><label for="slTr">Transition</label><select id="slTr" data-sl-in="tr"><option value="fade"' + (slide.tr === "fade" ? " selected" : "") + '>Fade</option><option value="push"' + (slide.tr === "push" ? " selected" : "") + '>Slide in</option><option value="zoom"' + (slide.tr === "zoom" ? " selected" : "") + '>Zoom</option><option value="none"' + (slide.tr === "none" ? " selected" : "") + ">None</option></select></div>" +
      '<div class="sl-row col"><label for="slNote">Teacher notes (students never see these)</label><textarea id="slNote" data-sl-in="note" rows="5">' + E(c.notes[slide.id] || "") + "</textarea></div></div>";
    if (!it) return add + '<p class="hint">Click an item on the slide to edit it. Drag to move, pull the corner to resize.</p>' + slideP;
    var h = add + '<div class="sl-pg"><b>' + (it.t === "text" ? "Text" : it.t === "box" ? "Box" : it.t === "img" ? "Picture" : "Audio") + "</b>";
    if (it.t === "text" || it.t === "box") {
      var first = it.paras && it.paras[0] && it.paras[0].runs[0] || {};
      h += '<div class="sl-row col"><label for="slTx">Text (one line per paragraph)</label><textarea id="slTx" data-sl-in="text" rows="5">' + E((it.paras || []).map(function (p) { return p.runs.map(function (r) { return r.t; }).join(""); }).join("\n")) + "</textarea></div>" +
        '<div class="sl-row"><label for="slSz">Size</label><input id="slSz" type="number" min="8" max="200" value="' + (first.sz || 18) + '" data-sl-in="size"><button type="button" class="btn sm sec' + (first.b ? " on" : "") + '" data-sl="bold">Bold</button>' +
        '<select data-sl-in="align" aria-label="Alignment"><option value="l"' + ((it.paras && it.paras[0] && it.paras[0].al) === "l" ? " selected" : "") + '>Left</option><option value="c"' + ((it.paras && it.paras[0] && it.paras[0].al) === "c" ? " selected" : "") + '>Centre</option><option value="r"' + ((it.paras && it.paras[0] && it.paras[0].al) === "r" ? " selected" : "") + ">Right</option></select>" +
        '<select data-sl-in="anchor" aria-label="Vertical position"><option value="t"' + (it.anchor === "t" ? " selected" : "") + '>Top</option><option value="m"' + (it.anchor === "m" ? " selected" : "") + '>Middle</option><option value="b"' + (it.anchor === "b" ? " selected" : "") + ">Bottom</option></select></div>" +
        '<div class="sl-row"><label>Text colour</label>' + colorSel("tc", first.c || "#16181D", false) + "</div>";
    }
    if (it.t === "box" || it.t === "text") {
      h += '<div class="sl-row"><label>Fill</label>' + colorSel("fill", it.fill, true) + "</div>" +
        '<div class="sl-row"><label>Outline</label>' + colorSel("line", it.line, true) + "</div>" +
        '<div class="sl-row"><label for="slShape">Shape</label><select id="slShape" data-sl-in="shape"><option value="rect"' + (it.shape !== "round" && it.shape !== "oval" ? " selected" : "") + '>Rectangle</option><option value="round"' + (it.shape === "round" ? " selected" : "") + '>Rounded</option><option value="oval"' + (it.shape === "oval" ? " selected" : "") + ">Oval</option></select></div>";
    }
    if (it.t === "audio") {
      var has = it.src && c.assets[it.src];
      h += '<div class="sl-row col"><label for="slLb">Button label</label><input id="slLb" value="' + E(it.label || "") + '" data-sl-in="label"></div>' +
        (has ? '<p class="hint">Audio uploaded: ' + E(c.assets[it.src].name || "file") + '</p><div class="sl-row"><button type="button" class="btn sm sec" data-aud="' + E(it.id) + '">Play / pause</button><button type="button" class="btn sm sec" data-sl="rmaudio">Remove audio</button></div>'
          : '<label class="btn sm">Upload audio (mp3, m4a, wav)<input type="file" accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/wav" data-sl-file="audfor" hidden></label>');
    }
    if (it.t === "img") h += '<label class="btn sm sec">Replace picture<input type="file" accept="image/*" data-sl-file="imgfor" hidden></label>';
    h += '<div class="sl-row"><label for="slStep">Appears on click no.</label><input id="slStep" type="number" min="0" max="40" value="' + (it.step || 0) + '" data-sl-in="step"><select data-sl-in="fx" aria-label="Animation"><option value="fade"' + ((it.fx || "fade") === "fade" ? " selected" : "") + '>Fade</option><option value="up"' + (it.fx === "up" ? " selected" : "") + '>Rise</option><option value="zoom"' + (it.fx === "zoom" ? " selected" : "") + '>Pop</option><option value="none"' + (it.fx === "none" ? " selected" : "") + ">Appear</option></select></div>" +
      '<p class="hint">0 = always visible. 1, 2, 3 = shown on the first, second, third click. Same number = shown together.</p>' +
      '<div class="sl-row"><label>Position (inches)</label>' + ["x", "y", "w", "h"].map(function (k) { return '<input type="number" step="0.05" class="num" value="' + it[k] + '" data-sl-in="pos" data-k="' + k + '" aria-label="' + k + '">'; }).join("") + "</div>" +
      '<div class="sl-row"><button type="button" class="btn sm sec" data-sl="dupitem">Duplicate</button><button type="button" class="btn sm sec" data-sl="front">Bring to front</button><button type="button" class="btn sm sec" data-sl="back">Send back</button><button type="button" class="btn sm danger" data-sl="delitem">Delete</button></div></div>';
    return h + slideP;
  }

  /* ------------------------------------------------------------ editing helpers */
  function snap() { var c = SL.cur; c.undo.push(JSON.stringify({ slides: c.slides, notes: c.notes, idx: c.idx })); if (c.undo.length > 40) c.undo.shift(); }
  function dirty() { SL.cur.dirty = true; var s = $("#slApp .sl-sub"); if (s) s.textContent = "Editing · unsaved changes"; var b = $('#slApp [data-sl="save"]'); if (b) b.disabled = false; }
  function redrawCanvas() {
    var c = SL.cur, box = $("#slCanvas"); if (!box) return;
    box.innerHTML = stageHTML(c.slides[c.idx], { assets: c.assets, all: true, edit: true }); fit(box); markSel();
    var th = $$("#slThumbs .sl-th")[c.idx]; if (th) { var f = $(".sl-fit", th); f.innerHTML = stageHTML(c.slides[c.idx], { assets: c.assets, all: true, edit: true }); fit(f); }
  }
  function redrawProps() { var p = $("#slProps"); if (p) p.innerHTML = propsHTML(); }
  function markSel() {
    var c = SL.cur, box = $("#slCanvas"); if (!box || box.getAttribute("data-edit") !== "1") return;
    $$(".sl-it", box).forEach(function (n) { n.classList.toggle("sel", n.getAttribute("data-id") === c.sel); var h = $(".sl-rs", n); if (h) h.remove(); });
    var n = c.sel && $('.sl-it[data-id="' + c.sel + '"]', box);
    if (n) { var h = document.createElement("span"); h.className = "sl-rs"; n.appendChild(h); }
  }
  function curSlide() { return SL.cur.slides[SL.cur.idx]; }
  function newItem(t) {
    if (t === "text") return { id: sid(), t: "text", x: 1, y: 1.6, w: 6, h: 1, step: 0, ins: [0.05, 0.03, 0.05, 0.03], anchor: "t", paras: [{ al: "l", runs: [{ t: "New text", sz: 24, c: "#16181D", f: "Source Sans 3" }] }] };
    return { id: sid(), t: "box", x: 1, y: 2, w: 4, h: 1.2, step: 0, shape: "round", rad: 0.2, fill: "#F2F3F5", line: "#E63946", lw: 2, anchor: "m", ins: [0.1, 0.05, 0.1, 0.05], paras: [{ al: "c", runs: [{ t: "Text", sz: 24, b: 1, c: "#16181D", f: "Source Sans 3" }] }] };
  }
  function setText(it, val) {
    var lines = String(val).split("\n"), old = it.paras || [];
    it.paras = lines.map(function (ln, i) {
      var src = old[Math.min(i, old.length - 1)] || { al: "l", runs: [{}] }, r0 = clone(src.runs[0] || {});
      r0.t = ln; var p = { al: src.al || "l", runs: [r0] }; if (src.sa) p.sa = src.sa; if (src.ls) p.ls = src.ls; return p;
    });
  }
  function eachRun(it, fn) { (it.paras || []).forEach(function (p) { p.runs.forEach(fn); }); }
  function setCol(name, v) {
    var c = SL.cur, it = selItem(); snap();
    if (name === "bg") curSlide().bg = v;
    else if (!it) return;
    else if (name === "tc") eachRun(it, function (r) { r.c = v; });
    else if (name === "fill") it.fill = v || null;
    else if (name === "line") { if (v) { it.line = v; it.lw = it.lw || 2; } else { delete it.line; } }
    dirty(); redrawCanvas(); redrawProps();
  }
  function setIn(el) {
    var c = SL.cur, k = el.getAttribute("data-sl-in"), it = selItem(), v = el.value;
    if (k === "note") { c.notes[curSlide().id] = v; dirty(); return; }
    if (k === "tr") { snap(); curSlide().tr = v; dirty(); return; }
    if (!it) return;
    if (el.getAttribute("data-typing") !== "1") { snap(); el.setAttribute("data-typing", "1"); }
    if (k === "text") setText(it, v);
    else if (k === "size") eachRun(it, function (r) { r.sz = Math.max(6, Number(v) || 18); });
    else if (k === "align") (it.paras || []).forEach(function (p) { p.al = v; });
    else if (k === "anchor") it.anchor = v;
    else if (k === "shape") { it.shape = v; if (v === "round" && it.rad == null) it.rad = 0.2; }
    else if (k === "label") it.label = v;
    else if (k === "step") it.step = Math.max(0, parseInt(v, 10) || 0);
    else if (k === "fx") it.fx = v;
    else if (k === "pos") it[el.getAttribute("data-k")] = Number(v) || 0;
    dirty(); redrawCanvas(); if (k === "step" || k === "fx") { /* keep focus in the field */ }
  }

  /* ------------------------------------------------------------ pointer: select, move, resize */
  var drag = null;
  function wireApp(el) {
    var cv = $("#slCanvas", el);
    if (cv && cv.getAttribute("data-edit") === "1") { markSel(); cv.addEventListener("pointerdown", onDown); }
    $$("input[data-sl-file]", el).forEach(function (inp) { inp.addEventListener("change", onFile); });
    $$("[data-sl-in]", el).forEach(function (n) {
      n.addEventListener(n.tagName === "SELECT" ? "change" : "input", function () { setIn(n); });
      n.addEventListener("blur", function () { n.removeAttribute("data-typing"); });
    });
  }
  function onDown(e) {
    var c = SL.cur, cv = e.currentTarget, itEl = e.target.closest(".sl-it"), box = cv.getBoundingClientRect(), scale = box.width / (W * PX);
    if (!itEl) { if (c.sel) { c.sel = null; markSel(); redrawProps(); } return; }
    var id = itEl.getAttribute("data-id"), it = curSlide().items.filter(function (i) { return i.id === id; })[0]; if (!it) return;
    if (e.target.closest(".sl-aud") ) e.preventDefault();
    var selChanged = c.sel !== id; c.sel = id; markSel(); if (selChanged) redrawProps();
    var resize = !!e.target.closest(".sl-rs");
    drag = { it: it, resize: resize, sx: e.clientX, sy: e.clientY, ox: it.x, oy: it.y, ow: it.w, oh: it.h, scale: scale, moved: false, el: itEl };
    cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
    cv.addEventListener("pointermove", onMove); cv.addEventListener("pointerup", onUp); cv.addEventListener("pointercancel", onUp);
    e.preventDefault();
  }
  function onMove(e) {
    if (!drag) return;
    var dx = (e.clientX - drag.sx) / drag.scale / PX, dy = (e.clientY - drag.sy) / drag.scale / PX;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 0.04) return;
    if (!drag.moved) { snap(); drag.moved = true; }
    var g = function (v) { return Math.round(v * 20) / 20; };
    if (drag.resize) { drag.it.w = Math.max(0.3, g(drag.ow + dx)); drag.it.h = Math.max(0.2, g(drag.oh + dy)); }
    else { drag.it.x = g(drag.ox + dx); drag.it.y = g(drag.oy + dy); }
    var n = drag.el; n.style.left = drag.it.x * PX + "px"; n.style.top = drag.it.y * PX + "px"; n.style.width = drag.it.w * PX + "px"; n.style.height = drag.it.h * PX + "px";
  }
  function onUp(e) {
    var cv = e.currentTarget; cv.removeEventListener("pointermove", onMove); cv.removeEventListener("pointerup", onUp); cv.removeEventListener("pointercancel", onUp);
    if (drag && drag.moved) { dirty(); redrawCanvas(); redrawProps(); }
    drag = null;
  }
  document.addEventListener("keydown", function (e) {
    var c = SL.cur; if (!c || !$("#slApp") || SL.show) return;
    var tag = (e.target.tagName || "").toLowerCase(); if (tag === "input" || tag === "textarea" || tag === "select") { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); } return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && c.mode === "edit") { e.preventDefault(); undo(); return; }
    if (e.key === "Escape") { closeApp(); return; }
    if (e.key === "ArrowRight" && !c.sel) { go(1); return; }
    if (e.key === "ArrowLeft" && !c.sel) { go(-1); return; }
    var it = selItem();
    if (it && c.mode === "edit") {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); delItem(); return; }
      var st = e.shiftKey ? 0.25 : 0.05, m = { ArrowLeft: ["x", -st], ArrowRight: ["x", st], ArrowUp: ["y", -st], ArrowDown: ["y", st] }[e.key];
      if (m) { e.preventDefault(); snap(); it[m[0]] = Math.round((it[m[0]] + m[1]) * 20) / 20; dirty(); redrawCanvas(); redrawProps(); }
    }
  });

  /* ------------------------------------------------------------ files: pictures and audio */
  function fileToImage(file) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var mw = 1400, s = Math.min(1, mw / img.width), cv = document.createElement("canvas"); cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        var cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
        var data = cv.toDataURL("image/jpeg", 0.85).split(",")[1]; URL.revokeObjectURL(url);
        res({ data: data, mime: "image/jpeg", w: cv.width, h: cv.height });
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("That picture could not be read.")); };
      img.src = url;
    });
  }
  function onFile(e) {
    var inp = e.target, kind = inp.getAttribute("data-sl-file"), file = inp.files && inp.files[0]; inp.value = ""; if (!file) return;
    var c = SL.cur, sb = A().sb;
    if (kind === "img" || kind === "imgfor") {
      toast("Adding picture…");
      fileToImage(file).then(function (im) {
        return sb.from("deck_assets").insert({ deck_id: c.id, kind: "image", name: file.name, mime: im.mime, data: im.data }).select("*").single().then(function (r) {
          if (r.error) throw new Error(r.error.message);
          c.assets[r.data.id] = r.data; snap();
          if (kind === "imgfor" && selItem()) selItem().src = r.data.id;
          else { var w = Math.min(6, im.w / 100), h = w * im.h / im.w; if (h > 5) { h = 5; w = h * im.w / im.h; } var it = { id: sid(), t: "img", x: 1, y: 1.5, w: Math.round(w * 20) / 20, h: Math.round(h * 20) / 20, step: 0, src: r.data.id }; curSlide().items.push(it); c.sel = it.id; }
          dirty(); redrawCanvas(); redrawProps();
        });
      }).catch(function (er) { toast(er.message, true); });
      return;
    }
    var ext = (file.name.split(".").pop() || "").toLowerCase(), mime = AUD_MIME[ext];
    if (!mime) { toast("Audio must be mp3, m4a or wav.", true); return; }
    if (file.size > 40 * 1024 * 1024) { toast("Audio files can be up to 40 MB.", true); return; }
    toast("Uploading audio…");
    var path = "decks/" + c.id + "/" + uid() + "." + ext;
    sb.storage.from("materials").upload(path, file, { contentType: mime, upsert: false }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return sb.from("deck_assets").insert({ deck_id: c.id, kind: "audio", name: file.name, mime: mime, file_path: path }).select("*").single();
    }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      c.assets[r.data.id] = r.data; snap();
      if (kind === "audfor" && selItem()) selItem().src = r.data.id;
      else { var it = { id: sid(), t: "audio", x: 0.6, y: 6.6, w: 3, h: 0.6, step: 0, label: "Listen", src: r.data.id }; curSlide().items.push(it); c.sel = it.id; }
      dirty(); redrawCanvas(); redrawProps(); toast("Audio added. Press Save to keep it.");
    }).catch(function (er) { toast(er.message || "Upload failed.", true); });
  }

  /* ------------------------------------------------------------ actions */
  function go(d) { var c = SL.cur, n = c.idx + d; if (n < 0 || n >= c.slides.length) return; c.idx = n; c.sel = null; refreshApp(); }
  function delItem() { var c = SL.cur, s = curSlide(); if (!c.sel) return; snap(); s.items = s.items.filter(function (i) { return i.id !== c.sel; }); c.sel = null; dirty(); redrawCanvas(); redrawProps(); }
  function undo() {
    var c = SL.cur; if (!c.undo.length) { toast("Nothing to undo."); return; }
    var s = JSON.parse(c.undo.pop()); c.slides = s.slides; c.notes = s.notes; c.idx = Math.min(s.idx, s.slides.length - 1); c.sel = null; dirty(); refreshApp();
  }
  function save() {
    var c = SL.cur, sb = A().sb; if (!c || !c.dirty) return;
    toast("Saving…");
    sb.from("decks").update({ slides: c.slides }).eq("id", c.id).select("id").then(function (r) {
      if (r.error) throw new Error(r.error.message);
      if (!r.data || !r.data.length) throw new Error("Nothing was saved. Sign in again and retry.");
      return sb.from("deck_notes").upsert({ deck_id: c.id, notes: c.notes, updated_at: new Date().toISOString() });
    }).then(function (r) {
      if (r && r.error) throw new Error(r.error.message);
      c.dirty = false; toast("Slides saved."); refreshApp();
    }).catch(function (e) { toast(e.message || "Could not save.", true); });
  }
  function closeApp() {
    var c = SL.cur; if (c && c.dirty && !window.confirm("You have unsaved changes. Close without saving?")) return;
    var el = $("#slApp"); if (el) el.remove(); document.body.classList.remove("sl-open"); SL.cur = null; syncAudioUI(); if (A().render) A().render();
  }
  function slAct(a, b) {
    var c = SL.cur; if (!c) return;
    if (a === "close") return closeApp();
    if (a === "show") return startShow();
    if (a === "edit") { c.mode = "edit"; return refreshApp(); }
    if (a === "view") { c.mode = "view"; c.sel = null; return refreshApp(); }
    if (a === "goto") { c.idx = Number(b.getAttribute("data-i")); c.sel = null; return refreshApp(); }
    if (a === "prev") return go(-1);
    if (a === "next") return go(1);
    if (a === "save") return save();
    if (a === "undo") return undo();
    if (a === "addslide") { snap(); var ns = blankSlide("New slide"); c.slides.splice(c.idx + 1, 0, ns); c.idx++; c.sel = null; dirty(); return refreshApp(); }
    if (a === "dupslide") { snap(); var cp = clone(curSlide()); cp.id = "s" + Math.random().toString(36).slice(2, 8); cp.items.forEach(function (i) { i.id = sid(); }); c.notes[cp.id] = c.notes[curSlide().id] || ""; c.slides.splice(c.idx + 1, 0, cp); c.idx++; dirty(); return refreshApp(); }
    if (a === "delslide") { if (c.slides.length < 2) return toast("A deck needs at least one slide."); if (!window.confirm("Delete this slide?")) return; snap(); c.slides.splice(c.idx, 1); c.idx = Math.max(0, c.idx - 1); c.sel = null; dirty(); return refreshApp(); }
    if (a === "up" || a === "down") { var j = c.idx + (a === "up" ? -1 : 1); if (j < 0 || j >= c.slides.length) return; snap(); var t = c.slides[c.idx]; c.slides[c.idx] = c.slides[j]; c.slides[j] = t; c.idx = j; dirty(); return refreshApp(); }
    if (a === "addtext" || a === "addbox") { snap(); var it = newItem(a === "addtext" ? "text" : "box"); curSlide().items.push(it); c.sel = it.id; dirty(); redrawCanvas(); return redrawProps(); }
    if (a === "delitem") return delItem();
    if (a === "dupitem") { var s0 = selItem(); if (!s0) return; snap(); var d = clone(s0); d.id = sid(); d.x += 0.3; d.y += 0.3; curSlide().items.push(d); c.sel = d.id; dirty(); redrawCanvas(); return redrawProps(); }
    if (a === "front" || a === "back") { var s1 = selItem(); if (!s1) return; snap(); var arr = curSlide().items; arr.splice(arr.indexOf(s1), 1); if (a === "front") arr.push(s1); else arr.unshift(s1); dirty(); return redrawCanvas(); }
    if (a === "bold") { var s2 = selItem(); if (!s2) return; snap(); var on = !(s2.paras && s2.paras[0] && s2.paras[0].runs[0] && s2.paras[0].runs[0].b); eachRun(s2, function (r) { if (on) r.b = 1; else delete r.b; }); dirty(); redrawCanvas(); return redrawProps(); }
    if (a === "color") return setCol(b.getAttribute("data-name"), b.getAttribute("data-v"));
    if (a === "rmaudio") { var s3 = selItem(); if (!s3) return; snap(); s3.src = null; dirty(); redrawCanvas(); return redrawProps(); }
  }
  document.addEventListener("click", function (e) {
    var au = e.target.closest("[data-aud]");
    if (au && (e.target.closest("#slApp") || e.target.closest("#slShow"))) { e.preventDefault(); toggleAudio(au.getAttribute("data-aud")); return; }
    var b = e.target.closest("#slApp [data-sl]"); if (!b) return;
    slAct(b.getAttribute("data-sl"), b);
  });

  /* ------------------------------------------------------------ audio (one player, works inside and outside the slide show) */
  var curAud = null;      // { id, label }
  function findItem(id) { var c = SL.cur || SL.show; if (!c) return null; for (var i = 0; i < c.slides.length; i++) { var f = c.slides[i].items.filter(function (x) { return x.id === id; })[0]; if (f) return f; } return null; }
  function toggleAudio(itemId) {
    var c = SL.cur || SL.show, it = findItem(itemId); if (!it || !it.src) return;
    if (curAud && curAud.id === itemId && audio.src) { if (audio.paused) audio.play(); else audio.pause(); return; }
    var as = c.assets[it.src]; if (!as || !as.file_path) return;
    A().sb.storage.from("materials").createSignedUrl(as.file_path, 3600).then(function (r) {
      if (r.error || !r.data) throw new Error((r.error && r.error.message) || "Audio not available.");
      audio.src = r.data.signedUrl; curAud = { id: itemId, label: it.label || as.name || "Audio" };
      return audio.play();
    }).catch(function (er) { toast(er && er.message ? er.message : "Audio could not play.", true); });
  }
  function syncAudioUI() {
    var playing = !audio.paused && !!curAud;
    $$("[data-aud]").forEach(function (n) { var on = playing && curAud && n.getAttribute("data-aud") === curAud.id; var ic = $(".sl-aud-ic", n); if (ic) ic.innerHTML = on ? "&#10074;&#10074;" : "&#9654;"; n.classList.toggle("playing", !!on); });
    if (!mini) { mini = document.createElement("div"); mini.id = "slMini"; mini.className = "slmini"; mini.hidden = true; document.body.appendChild(mini);
      mini.addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; if (b.getAttribute("data-m") === "pp") { if (audio.paused) audio.play(); else audio.pause(); } else { audio.pause(); audio.removeAttribute("src"); audio.load(); curAud = null; syncAudioUI(); } }); }
    if (curAud && audio.src) { mini.hidden = false; mini.innerHTML = '<span class="sl-mini-t">' + E(curAud.label) + '</span><button type="button" class="btn sm" data-m="pp" aria-label="Play or pause">' + (playing ? "Pause" : "Play") + '</button><button type="button" class="btn sm sec" data-m="x" aria-label="Stop audio">Stop</button>'; }
    else mini.hidden = true;
  }
  ["play", "pause", "ended", "emptied"].forEach(function (ev) { audio.addEventListener(ev, syncAudioUI); });

  /* ------------------------------------------------------------ slide show */
  function startShow() {
    var c = SL.cur; if (!c) return;
    SL.show = { slides: c.slides, assets: c.assets, notes: c.notes, idx: c.idx, step: 0, fromEdit: c.mode };
    var el = $("#slShow"); if (el) el.remove();
    el = document.createElement("div"); el.id = "slShow"; el.className = "slshow"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Slide show");
    document.body.appendChild(el);
    el.innerHTML = '<div class="sl-sbox" id="slSbox"></div><div class="sl-ctl" id="slCtl"><button type="button" data-sh="prev" class="btn sm sec" aria-label="Previous">&larr;</button><span id="slCnt"></span><button type="button" data-sh="next" class="btn sm sec" aria-label="Next">&rarr;</button><span id="slAudCtl"></span><button type="button" data-sh="full" class="btn sm sec">Full screen</button><button type="button" data-sh="exit" class="btn sm">Exit</button></div>';
    el.addEventListener("click", onShowClick);
    document.addEventListener("keydown", onShowKey, true);
    window.addEventListener("resize", showFit);
    drawShow("none");
    if (el.requestFullscreen) { el.requestFullscreen().catch(function () { /* stays in the page */ }); }
    document.addEventListener("fullscreenchange", onFsChange);
  }
  function onFsChange() { if (!document.fullscreenElement && SL.show && SL.show.wantFs) { /* user left full screen; keep the show open */ } showFit(); }
  function showFit() {
    var box = $("#slSbox"); if (!box) return; var st = box.firstElementChild; if (!st) return;
    var s = Math.min(box.clientWidth / (W * PX), box.clientHeight / (H * PX)); st.style.transform = "scale(" + s + ")"; st.style.left = (box.clientWidth - W * PX * s) / 2 + "px"; st.style.top = (box.clientHeight - H * PX * s) / 2 + "px";
  }
  function drawShow(how) {
    var sh = SL.show, slide = sh.slides[sh.idx], box = $("#slSbox"); if (!box) return;
    box.innerHTML = stageHTML(slide, { assets: sh.assets, step: sh.step, edit: false });
    var st = box.firstElementChild; st.classList.add("sl-pos"); showFit();
    var tr = how || slide.tr || "fade"; st.classList.add("tr-" + tr);
    $("#slCnt").textContent = (sh.idx + 1) + " / " + sh.slides.length + (maxStep(slide) ? "  ·  click " + sh.step + "/" + maxStep(slide) : "");
    var auds = (slide.items || []).filter(function (i) { return i.t === "audio" && i.src && sh.assets[i.src]; });
    $("#slAudCtl").innerHTML = auds.map(function (i) { return '<button type="button" class="btn sm sec" data-aud="' + E(i.id) + '"><span class="sl-aud-ic">&#9654;</span> ' + E(i.label || "Listen") + "</button>"; }).join("");
    syncAudioUI();
  }
  function showNext() {
    var sh = SL.show, slide = sh.slides[sh.idx];
    if (sh.step < maxStep(slide)) { sh.step++; $$("#slSbox .sl-step").forEach(function (n) { if (Number(n.getAttribute("data-step")) <= sh.step) { n.classList.remove("off"); n.classList.add("on"); } }); $("#slCnt").textContent = (sh.idx + 1) + " / " + sh.slides.length + "  ·  click " + sh.step + "/" + maxStep(slide); return; }
    if (sh.idx < sh.slides.length - 1) { sh.idx++; sh.step = 0; drawShow(); } else exitShow();
  }
  function showPrev() {
    var sh = SL.show;
    if (sh.step > 0) { sh.step--; $$("#slSbox .sl-step").forEach(function (n) { if (Number(n.getAttribute("data-step")) > sh.step) { n.classList.add("off"); n.classList.remove("on"); } }); $("#slCnt").textContent = (sh.idx + 1) + " / " + sh.slides.length + "  ·  click " + sh.step + "/" + maxStep(sh.slides[sh.idx]); return; }
    if (sh.idx > 0) { sh.idx--; sh.step = maxStep(sh.slides[sh.idx]); drawShow("none"); }
  }
  function exitShow() {
    var sh = SL.show; if (!sh) return;
    document.removeEventListener("keydown", onShowKey, true); window.removeEventListener("resize", showFit); document.removeEventListener("fullscreenchange", onFsChange);
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    var el = $("#slShow"); if (el) el.remove();
    if (SL.cur) { SL.cur.idx = sh.idx; }
    SL.show = null;
    if (SL.cur) refreshApp(); else { syncAudioUI(); }
  }
  function onShowKey(e) {
    if (!SL.show) return;
    var k = e.key;
    if (k === "ArrowRight" || k === "PageDown" || k === " " || k === "Enter") { e.preventDefault(); e.stopPropagation(); showNext(); }
    else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace") { e.preventDefault(); e.stopPropagation(); showPrev(); }
    else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); exitShow(); }
    else if (k === "Home") { SL.show.idx = 0; SL.show.step = 0; drawShow("none"); }
    else if (k === "End") { SL.show.idx = SL.show.slides.length - 1; SL.show.step = 0; drawShow("none"); }
    else if (k === "f" || k === "F") toggleFs();
  }
  function toggleFs() { var el = $("#slShow"); if (!el) return; if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); }
  function onShowClick(e) {
    if (e.target.closest("[data-aud]")) return;
    var b = e.target.closest("[data-sh]");
    if (b) { var a = b.getAttribute("data-sh"); if (a === "next") showNext(); else if (a === "prev") showPrev(); else if (a === "exit") exitShow(); else if (a === "full") toggleFs(); return; }
    if (e.target.closest(".sl-ctl")) return;
    var r = e.clientX / window.innerWidth; if (r < 0.2) showPrev(); else showNext();
  }

  /* ------------------------------------------------------------ lists inside the app */
  function deckCard(d, staff) {
    var h = '<div class="card"><div class="l1"><span class="t">' + E(d.title) + '</span><span class="pills">' + (staff ? (d.visible_to_students ? '<span class="pill ok">Students can view</span>' : '<span class="pill">Hidden from students</span>') : "") + "</span></div><div class=\"acts\" style=\"flex-wrap:wrap\">" +
      '<button type="button" class="btn sm" data-act="sl_show" data-id="' + d.id + '">&#9654; Slide show</button><button type="button" class="btn sm sec" data-act="sl_view" data-id="' + d.id + '">View</button>' +
      (staff ? '<button type="button" class="btn sm sec" data-act="sl_edit" data-id="' + d.id + '">Edit</button><button type="button" class="btn sm sec" data-act="sl_vis" data-id="' + d.id + '">' + (d.visible_to_students ? "Hide from students" : "Show to students") + "</button>" : "") +
      (isAdmin() ? '<button type="button" class="btn sm danger" data-act="sl_del" data-id="' + d.id + '">Delete</button>' : "") + "</div></div>";
    return h;
  }
  /* admin and teacher: slides of one plan lesson */
  function panel(lessonId) {
    load();
    var list = SL.decks.filter(function (d) { return d.cur_lesson_id === lessonId; });
    return '<div class="sec"><h3>Slides in the browser</h3><p class="hint">View, present and edit slides here. Pictures, animations, transitions and audio can be added in the editor. Students see them only when you choose Show to students and the lesson is linked to one of their lessons.</p><div class="cards">' +
      (list.map(function (d) { return deckCard(d, true); }).join("") || '<p class="hint">No browser slides for this lesson yet.</p>') + "</div>" +
      '<div class="acts"><button type="button" class="btn sm" data-act="sl_new" data-id="' + lessonId + '">New blank deck</button></div></div>';
  }
  /* all decks, for the teacher portal */
  function teacherPanel() {
    load();
    return '<div class="panel"><div class="sec"><h3>Slides</h3><p class="hint">Open a deck to present it or to edit it.</p><div class="cards">' +
      (SL.decks.map(function (d) { return deckCard(d, true); }).join("") || '<p class="hint">No slides yet.</p>') + "</div></div></div>";
  }
  /* student: decks visible to her */
  function studentCards() {
    load();
    if (!SL.decks.length) return "";
    return '<div class="sec"><h3>Your slides</h3><p class="hint">Open the slides on any device and use Slide show to present. Click or press the right arrow to move on.</p><div class="cards">' + SL.decks.map(function (d) { return deckCard(d, false); }).join("") + "</div></div>";
  }
  function click(a, id) {
    if (a === "sl_view") { open(id, "view"); return true; }
    if (a === "sl_show") { open(id, "show"); return true; }
    if (a === "sl_edit") { open(id, "edit"); return true; }
    if (a === "sl_vis") {
      var d = deckById(id); if (!d) return true;
      A().sb.from("decks").update({ visible_to_students: !d.visible_to_students }).eq("id", id).select("id").then(function (r) {
        if (r.error || !r.data || !r.data.length) { toast("Could not change visibility.", true); return; }
        d.visible_to_students = !d.visible_to_students; toast(d.visible_to_students ? "Students can now view these slides." : "Hidden from students."); A().render();
      }); return true;
    }
    if (a === "sl_new") {
      var title = window.prompt("Name for the new deck", "New slides"); if (!title) return true;
      var s = blankSlide(title);
      A().sb.from("decks").insert({ cur_lesson_id: id, title: title, slides: [s] }).select("id,cur_lesson_id,title,visible_to_students,updated_at").single().then(function (r) {
        if (r.error) { toast(r.error.message, true); return; }
        SL.decks.push(r.data); open(r.data.id, "edit");
      }); return true;
    }
    if (a === "sl_del") {
      var dd = deckById(id); if (!dd || !window.confirm("Delete the deck \"" + dd.title + "\" for good?")) return true;
      A().sb.from("decks").delete().eq("id", id).then(function (r) { if (r.error) { toast(r.error.message, true); return; } SL.decks = SL.decks.filter(function (x) { return x.id !== id; }); toast("Deck deleted."); A().render(); }); return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ one-time encrypted imports (admin) */
  function hex2buf(h) { var b = new Uint8Array(h.length / 2); for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
  function b64buf(s) { var bin = atob(s), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
  function runImports() {
    if (!isAdmin()) return Promise.resolve();
    var sb = A().sb;
    return sb.from("import_jobs").select("*").eq("done", false).then(function (r) {
      var jobs = (r && r.data) || [];
      return jobs.reduce(function (p, job) { return p.then(function () { return doImport(job); }); }, Promise.resolve());
    }, function () { /* table not there */ });
  }
  function doImport(job) {
    var sb = A().sb, bucket = sb.storage.from("materials");
    toast("Importing " + job.name + "…");
    return fetch(job.file, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("Import file not found (" + job.file + ")"); return r.arrayBuffer(); }).then(function (buf) {
      var u = new Uint8Array(buf), iv = u.slice(0, 12), ct = u.slice(12);
      return crypto.subtle.importKey("raw", hex2buf(job.key), "AES-GCM", false, ["decrypt"]).then(function (k) { return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, k, ct); });
    }).then(function (pt) {
      var B = JSON.parse(new TextDecoder().decode(pt)), parts = B.lesson_ref.split(":");
      return sb.from("cur_levels").select("id").eq("code", parts[0]).maybeSingle().then(function (lv) {
        return sb.from("cur_lessons").select("id").eq("level_id", lv.data.id).eq("number", Number(parts[1])).maybeSingle();
      }).then(function (ls) {
        var lid = ls.data.id, chain = Promise.resolve();
        if (B.deck) {
          chain = chain.then(function () { return sb.from("decks").select("id").eq("cur_lesson_id", lid).eq("title", B.deck.title).maybeSingle(); }).then(function (ex) {
            if (ex.data) return;
            var deckId = uid(), map = {}, rows = [];
            Object.keys(B.assets).forEach(function (k) { map[k] = uid(); rows.push({ id: map[k], deck_id: deckId, kind: B.assets[k].kind, name: B.assets[k].name, mime: B.assets[k].mime, data: B.assets[k].data }); });
            B.deck.slides.forEach(function (s) { s.items.forEach(function (i) { if (i.t === "img" && i.src) i.src = map[i.src]; }); });
            return sb.from("decks").insert({ id: deckId, cur_lesson_id: lid, title: B.deck.title, slides: B.deck.slides, visible_to_students: false }).then(function (r1) {
              if (r1.error) throw new Error(r1.error.message);
              var p = Promise.resolve();
              for (var i = 0; i < rows.length; i += 4) (function (part) { p = p.then(function () { return sb.from("deck_assets").insert(part).then(function (r2) { if (r2.error) throw new Error(r2.error.message); }); }); })(rows.slice(i, i + 4));
              return p.then(function () { return sb.from("deck_notes").upsert({ deck_id: deckId, notes: B.notes || {} }); });
            });
          });
        }
        (B.files || []).forEach(function (f) {
          chain = chain.then(function () { return sb.from("cur_files").select("id").eq("lesson_id", lid).eq("file_name", f.file_name).maybeSingle(); }).then(function (ex) {
            if (ex.data) return;
            var path = "kits/" + lid + "/" + uid() + "-" + f.file_name.replace(/[^\w.\-]+/g, "-"), bytes = b64buf(f.b64);
            return bucket.upload(path, new Blob([bytes], { type: f.mime }), { contentType: f.mime, upsert: false }).then(function (up) {
              if (up.error) throw new Error(up.error.message);
              return sb.from("cur_files").insert({ lesson_id: lid, kind: f.kind, title: f.title, for_student: f.for_student, file_path: path, file_name: f.file_name, mime: f.mime, size_bytes: bytes.length });
            }).then(function (ins) { if (ins.error) throw new Error(ins.error.message); });
          });
        });
        return chain;
      });
    }).then(function () {
      return sb.from("import_jobs").update({ done: true, key: null }).eq("name", job.name);
    }).then(function () { toast("Imported: " + job.name); load(true); return A().refresh && A().refresh(); })
      .catch(function (e) { toast("Import failed: " + (e.message || e), true); });
  }

  window.CLEAR_SL = { click: click, panel: panel, teacherPanel: teacherPanel, studentCards: studentCards, load: load, reset: function () { SL.loaded = false; SL.loading = false; SL.decks = []; }, runImports: runImports };
})();
