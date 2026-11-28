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
  /* check and cross stamps: drawn as strokes on a 40 x 40 square (0.4 in on the 13.33 x 7.5 in slide), so they scale with the slide.
     The same path draws the toolbar icon and the mark on the canvas. A colour override can later replace the "c" of a kind (see stampColor). */
  var STAMP_SIZE = 40, STAMP_LW = 6.5;
  var STAMP = { check: { c: "#1B7F5F", d: "M8 21L16 29L32 11", label: "Check mark" }, cross: { c: "#E63946", d: "M9 9L31 31M31 9L9 31", label: "Cross mark" } };
  function stampIcon(k) { return '<svg viewBox="0 0 ' + STAMP_SIZE + " " + STAMP_SIZE + '" width="18" height="18" aria-hidden="true" focusable="false"><path d="' + STAMP[k].d + '" fill="none" stroke="' + STAMP[k].c + '" stroke-width="' + STAMP_LW + '" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
  function stampColor(k) { return (SL.show && SL.show.stampCol && SL.show.stampCol[k]) || STAMP[k].c; }
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
    A().sb.from("decks").select("id,cur_lesson_id,title,visible_to_students,updated_at,source_file_id").order("created_at").then(function (r) {
      SL.decks = (r && r.data) || []; SL.loaded = true; SL.loading = false; setTimeout(doSweep, 300);
      var h = location.hash; if (A().render && !SL.cur && !SL.show) A().render();
    }, function () { SL.loading = false; SL.loaded = true; });
  }
  function deckById(id) { return SL.decks.filter(function (d) { return d.id === id; })[0]; }

  /* ------------------------------------------------------------ rendering a slide */
  /* video times: "1:28" or "88" or "1:02:03" -> seconds; seconds -> "m:ss" */
  function parseT(s) {
    s = String(s == null ? "" : s).trim(); if (!s) return 0;
    var p = s.split(":").map(Number); if (p.some(function (n) { return !isFinite(n) || n < 0; })) return 0;
    return Math.round(p.reduce(function (a, n) { return a * 60 + n; }, 0) * 10) / 10;
  }
  function fmtT(sec) { sec = Math.max(0, Math.round(Number(sec) || 0)); return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2); }
  function css(o) { return Object.keys(o).map(function (k) { return k + ":" + o[k]; }).join(";"); }
  function itemHTML(it, ctx) {
    var st = { left: it.x * PX + "px", top: it.y * PX + "px", width: it.w * PX + "px", height: it.h * PX + "px" };
    var cls = "sl-it sl-" + it.t, attrs = ' data-id="' + E(it.id) + '"';
    /* trigger animation: hidden until the item named in it.trigger is clicked (any order, no click number). A trigger that points at nothing is ignored, so an item is never lost. */
    var hold = !ctx.edit && (!ctx.all || ctx.live), tgOf = it.trigger && it.trigger !== it.id && ctx.ids && ctx.ids[it.trigger] ? it.trigger : null;
    if (tgOf) { cls += " sl-tg" + (hold ? " off" : " on"); attrs += ' data-trigger="' + E(tgOf) + '" data-fx="' + E(it.fx || "fade") + '"'; }
    else if (it.step) { cls += " sl-step"; attrs += ' data-step="' + it.step + '" data-fx="' + E(it.fx || "fade") + '"'; if (!ctx.all && it.step > ctx.step) cls += " off"; else cls += " on"; }
    if (hold && ctx.srcs && ctx.srcs[it.id]) cls += " sl-trigger";
    if (it.t === "img") {
      var a = ctx.assets[it.src];
      return '<div class="' + cls + '" style="' + css(st) + '"' + attrs + ">" + (a && a.data ? '<img alt="" draggable="false" src="data:' + E(a.mime) + ";base64," + a.data + '">' : '<div class="sl-missing">Picture</div>') + "</div>";
    }
    if (it.t === "video") {
      /* a real <video> only where it can play (slide show and the viewer's big slide); thumbnails and the editor show a still placeholder */
      var va = it.src && ctx.assets[it.src], playable = !ctx.edit && (ctx.live || !ctx.all);
      if (!va && !ctx.edit) return "";
      var vin = va && playable
        ? '<video class="sl-vid" playsinline preload="metadata" controls controlsList="nodownload" data-vsrc="' + E(it.src) + '" data-from="' + (Number(it.from) || 0) + '" data-to="' + (Number(it.to) || 0) + '"' + (it.keep ? ' data-keep="' + E(it.keep) + '"' : "") + "></video>"
        : '<div class="sl-vid-ph"><span class="sl-vid-ic">&#9654;</span><span class="sl-vid-lb">' + (va ? E(it.label || va.name || "Video") : "Add video here") + "</span></div>";
      return '<div class="' + cls + (va ? "" : " sl-vid-empty") + '" style="' + css(st) + '"' + attrs + ">" + vin + "</div>";
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
    var its = slide.items || []; ctx.ids = {}; ctx.srcs = {};
    its.forEach(function (i) { ctx.ids[i.id] = 1; });
    its.forEach(function (i) { if (i.trigger && i.trigger !== i.id && ctx.ids[i.trigger]) ctx.srcs[i.trigger] = 1; });
    return '<div class="sl-stage" style="background:' + E(slide.bg || "#FFFFFF") + '">' + (slide.items || []).map(function (it) { return itemHTML(it, ctx); }).join("") + "</div>";
  }
  /* click a trigger item: show (or hide again) every item that names it. Items re-render when a slide is entered, so they start hidden each time. */
  function trigToggle(root, srcId) {
    var els = $$(".sl-tg", root).filter(function (n) { return n.getAttribute("data-trigger") === srcId; });
    if (!els.length) return;
    var show = els.some(function (n) { return n.classList.contains("off"); });
    els.forEach(function (n) { n.classList.toggle("off", !show); n.classList.toggle("on", show); });
  }
  function trigClick(e, root) {
    var t = e.target.closest && e.target.closest(".sl-trigger"); if (!t || !root || !root.contains(t)) return false;
    trigToggle(root, t.getAttribute("data-id")); return true;
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
      return '<div role="button" tabindex="0"' + (edit ? ' draggable="true" title="Drag to move this slide"' : "") + ' class="sl-th' + (i === c.idx ? " cur" : "") + '" data-sl="goto" data-i="' + i + '" aria-label="Slide ' + (i + 1) + '"><span class="sl-n">' + (i + 1) + '</span><span class="sl-fit">' + stageHTML(s, { assets: c.assets, all: true, edit: edit }) + "</span></div>";
    }).join("") + (edit ? '<div class="sl-th-acts"><button type="button" class="btn sm sec" data-sl="addslide">+ Slide</button><button type="button" class="btn sm sec" data-sl="dupslide">Duplicate</button><button type="button" class="btn sm sec" data-sl="up">&uarr;</button><button type="button" class="btn sm sec" data-sl="down">&darr;</button><button type="button" class="btn sm sec" data-sl="delslide">Delete</button></div>' : "") + "</div>";
    var slide = c.slides[c.idx];
    var main = '<div class="sl-main"><div class="sl-canvas" style="width:100%;max-width:1100px;margin:0 auto"><div class="sl-fit" id="slCanvas" data-edit="' + (edit ? 1 : 0) + '">' + stageHTML(slide, { assets: c.assets, all: true, edit: edit, live: !edit }) + "</div></div>" +
      '<div class="sl-nav"><button type="button" class="btn sm sec" data-sl="prev">&larr; Previous</button><span>Slide ' + (c.idx + 1) + " of " + c.slides.length + '</span><button type="button" class="btn sm sec" data-sl="next">Next &rarr;</button></div>' +
      (audioBarHTML(slide) || "") + (!edit && isStaff() && c.notes[slide.id] ? '<div class="sl-notes"><b>Teacher notes</b><p>' + E(c.notes[slide.id]) + "</p></div>" : "") + "</div>";
    var props = edit ? '<div class="sl-props" id="slProps">' + propsHTML() + "</div>" : "";
    return bar + '<div class="sl-body' + (edit ? " edit" : "") + '" style="flex:1;min-height:0;display:grid;grid-template-columns:' + (window.innerWidth <= 640 ? "minmax(0,1fr)" : window.innerWidth <= 1100 ? (edit ? "120px minmax(0,1fr) 250px" : "120px minmax(0,1fr)") : (edit ? "168px minmax(0,1fr) 310px" : "168px minmax(0,1fr)")) + '">' + thumbs + main + props + "</div>";
  }
  function audioBarHTML(slide) {
    var list = (slide.items || []).filter(function (i) { return i.t === "audio" && i.src && SL.cur.assets[i.src]; });
    if (!list.length) return "";
    return '<div class="sl-audbar"><b>Audio on this slide</b>' + list.map(function (i) { return '<button type="button" class="btn sm sec" data-aud="' + E(i.id) + '"><span class="sl-aud-ic">&#9654;</span> ' + E(i.label || "Listen") + "</button>"; }).join("") + "</div>";
  }
  function refreshApp(keepProps) {
    var el = $("#slApp"); if (!el || !SL.cur) return;
    var edit = SL.cur.mode === "edit" && isStaff();
    var oldT = $("#slThumbs"), keep = oldT ? [oldT.scrollTop, oldT.scrollLeft] : null;
    el.innerHTML = appHTML(edit); fitAll(el); wireApp(el); syncAudioUI();
    thumbsReveal(keep);
  }
  /* keep the slide list where it was, and make sure the slide on screen is always visible in it */
  function thumbsReveal(keep) {
    var box = $("#slThumbs"), c = SL.cur; if (!box || !c) return;
    if (keep) { box.scrollTop = keep[0]; box.scrollLeft = keep[1]; }
    var th = $$(".sl-th", box)[c.idx]; if (!th) return;
    var r = th.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (!keep) { box.scrollTop += (r.top - b.top) - (b.height - r.height) / 2; box.scrollLeft += (r.left - b.left) - (b.width - r.width) / 2; return; } /* just opened: centre it */
    if (r.top < b.top) box.scrollTop -= (b.top - r.top) + 10; else if (r.bottom > b.bottom) box.scrollTop += (r.bottom - b.bottom) + 10;
    if (r.left < b.left) box.scrollLeft -= (b.left - r.left) + 10; else if (r.right > b.right) box.scrollLeft += (r.right - b.right) + 10;
  }

  /* ------------------------------------------------------------ editor: properties panel */
  /* selection: c.sel is the main item; c.more holds the others of a multi-selection (valid only while c.sel is still the anchor it was made with) */
  function selIds() {
    var c = SL.cur; if (!c || !c.sel) return [];
    var ids = [c.sel]; if (c.more && c.moreAnchor === c.sel && c.moreIdx === c.idx) c.more.forEach(function (i) { if (ids.indexOf(i) < 0) ids.push(i); });
    var have = {}; c.slides[c.idx].items.forEach(function (i) { have[i.id] = 1; });
    return ids.filter(function (i) { return have[i]; });
  }
  function selItems() { var ids = selIds(); return SL.cur ? SL.cur.slides[SL.cur.idx].items.filter(function (i) { return ids.indexOf(i.id) >= 0; }) : []; }
  function setSelIds(ids) { var c = SL.cur; c.sel = ids.length ? ids[ids.length - 1] : null; c.more = ids.slice(0, -1); c.moreAnchor = c.sel; c.moreIdx = c.idx; }
  var clip = null; /* items copied with Ctrl+C, kept across slides */
  function selItem() { var c = SL.cur; if (!c || !c.sel) return null; return c.slides[c.idx].items.filter(function (i) { return i.id === c.sel; })[0] || null; }
  function colorSel(name, val, withNone) {
    return '<div class="sl-sw" data-name="' + name + '">' + (withNone ? '<button type="button" class="sw none' + (!val ? " on" : "") + '" data-sl="color" data-name="' + name + '" data-v="" title="None">&times;</button>' : "") +
      PALETTE.map(function (c) { return '<button type="button" class="sw' + (val && val.toLowerCase() === c.toLowerCase() ? " on" : "") + '" style="background:' + c + '" data-sl="color" data-name="' + name + '" data-v="' + c + '" aria-label="' + c + '"></button>'; }).join("") + "</div>";
  }
  function trigOptions(slide, it) {
    var o = '<option value="">No (use the click number)</option>';
    (slide.items || []).forEach(function (i, n) {
      if (i.id === it.id || i.trigger === it.id) return; /* not itself, and never a loop */
      var tx = (i.paras || []).map(function (p) { return p.runs.map(function (r) { return r.t; }).join(""); }).join(" ").replace(/\s+/g, " ").trim();
      var lb = (n + 1) + ". " + (i.t === "img" ? "Picture" : i.t === "audio" ? "Audio" : i.t === "video" ? "Video" : tx ? tx.slice(0, 30) + (tx.length > 30 ? "…" : "") : "Shape");
      o += '<option value="' + E(i.id) + '"' + (it.trigger === i.id ? " selected" : "") + ">" + E(lb) + "</option>";
    });
    return o;
  }
  function propsHTML() {
    var c = SL.cur, slide = c.slides[c.idx], it = selItem();
    var add = '<div class="sl-add"><b>Add</b><button type="button" class="btn sm sec" data-sl="addtext">Text</button><button type="button" class="btn sm sec" data-sl="addbox">Box</button>' +
      '<label class="btn sm sec">Picture<input type="file" accept="image/*" data-sl-file="img" hidden></label><label class="btn sm sec">Audio<input type="file" accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/wav" data-sl-file="aud" hidden></label><label class="btn sm sec">Video<input type="file" accept=".mp4,.m4v,video/mp4" data-sl-file="vid" hidden></label></div>';
    var slideP = '<div class="sl-pg"><b>This slide</b><div class="sl-row"><label>Background</label>' + colorSel("bg", slide.bg, false) + "</div>" +
      '<div class="sl-row"><label for="slTr">Transition</label><select id="slTr" data-sl-in="tr"><option value="fade"' + (slide.tr === "fade" ? " selected" : "") + '>Fade</option><option value="push"' + (slide.tr === "push" ? " selected" : "") + '>Slide in</option><option value="zoom"' + (slide.tr === "zoom" ? " selected" : "") + '>Zoom</option><option value="none"' + (slide.tr === "none" ? " selected" : "") + ">None</option></select></div>" +
      '<div class="sl-row col"><label for="slNote">Teacher notes (students never see these)</label><textarea id="slNote" data-sl-in="note" rows="5">' + E(c.notes[slide.id] || "") + "</textarea></div></div>";
    if (!it) return add + '<p class="hint">Click an item to select it. Hold Ctrl and click to select several. Double-click text to type on the slide. Drag to move, pull the corner to resize. Ctrl+C and Ctrl+V copy and paste.</p>' + slideP;
    var many = selItems();
    if (many.length > 1) {
      var f0 = many[0], fx0 = (f0.fx || "fade");
      return add + '<div class="sl-pg"><b>' + many.length + ' items selected</b>' +
        '<div class="sl-row"><label>Text colour</label>' + colorSel("tc", "", false) + "</div>" +
        '<div class="sl-row"><label>Fill</label>' + colorSel("fill", "", true) + "</div>" +
        '<div class="sl-row"><label>Outline</label>' + colorSel("line", "", true) + "</div>" +
        '<div class="sl-row"><label for="slStep">Appears on click no.</label><input id="slStep" type="number" min="0" max="40" value="' + (f0.step || 0) + '" data-sl-in="step"><select data-sl-in="fx" aria-label="Animation"><option value="fade"' + (fx0 === "fade" ? " selected" : "") + '>Fade</option><option value="up"' + (fx0 === "up" ? " selected" : "") + '>Rise</option><option value="zoom"' + (fx0 === "zoom" ? " selected" : "") + '>Pop</option><option value="none"' + (fx0 === "none" ? " selected" : "") + ">Appear</option></select></div>" +
        '<p class="hint">Drag to move them together. Arrow keys nudge them. Ctrl+C then Ctrl+V copies them. Ctrl and click an item to add it or take it out.</p>' +
        '<div class="sl-row"><button type="button" class="btn sm sec" data-sl="dupitem">Duplicate</button><button type="button" class="btn sm sec" data-sl="front">Bring to front</button><button type="button" class="btn sm sec" data-sl="back">Send back</button><button type="button" class="btn sm danger" data-sl="delitem">Delete</button></div></div>' + slideP;
    }
    var h = add + '<div class="sl-pg"><b>' + (it.t === "text" ? "Text" : it.t === "box" ? "Box" : it.t === "img" ? "Picture" : it.t === "video" ? "Video" : "Audio") + "</b>";
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
    if (it.t === "video") {
      var vh = it.src && c.assets[it.src];
      h += '<div class="sl-row col"><label for="slLb">Label (shown in the slide show bar)</label><input id="slLb" value="' + E(it.label || "") + '" data-sl-in="label" placeholder="Video"></div>' +
        (vh ? '<p class="hint">Video uploaded: ' + E(vh.name || "file") + '</p>' +
          '<div class="sl-row"><label for="slVf">Start at</label><input id="slVf" type="text" class="num" value="' + fmtT(it.from) + '" data-sl-in="vfrom" placeholder="0:00" aria-label="Start at (m:ss)"><label for="slVt">Stop at</label><input id="slVt" type="text" class="num" value="' + (it.to ? fmtT(it.to) : "") + '" data-sl-in="vto" placeholder="end" aria-label="Stop at (m:ss)"></div>' +
          '<div class="sl-row"><label for="slKp">Carry on from the slide before</label><input id="slKp" type="text" value="' + E(it.keep || "") + '" data-sl-in="vkeep" placeholder="same word on both slides"></div>' +
          '<p class="hint">Give two slides one word here and the video keeps playing when you move from the first to the second (and carries on by itself if it had paused at its stop point).</p>' +
          '<p class="hint">The video starts at the first time and pauses by itself at the second. Leave "Stop at" empty to play to the end. Use m:ss (for example 1:28) or seconds.</p>' +
          '<label class="btn sm sec">Replace video<input type="file" accept=".mp4,.m4v,video/mp4" data-sl-file="vidfor" hidden></label>'
          : '<label class="btn sm">Upload video (mp4, up to 50 MB)<input type="file" accept=".mp4,.m4v,video/mp4" data-sl-file="vidfor" hidden></label>');
    }
    if (it.t === "img") h += '<label class="btn sm sec">Replace picture<input type="file" accept="image/*" data-sl-file="imgfor" hidden></label>';
    h += '<div class="sl-row"><label for="slStep">Appears on click no.</label><input id="slStep" type="number" min="0" max="40" value="' + (it.step || 0) + '" data-sl-in="step"><select data-sl-in="fx" aria-label="Animation"><option value="fade"' + ((it.fx || "fade") === "fade" ? " selected" : "") + '>Fade</option><option value="up"' + (it.fx === "up" ? " selected" : "") + '>Rise</option><option value="zoom"' + (it.fx === "zoom" ? " selected" : "") + '>Pop</option><option value="none"' + (it.fx === "none" ? " selected" : "") + ">Appear</option></select></div>" +
      '<p class="hint">0 = always visible. 1, 2, 3 = shown on the first, second, third click. Same number = shown together.</p>' +
      '<div class="sl-row"><label for="slTrg">Reveal on click of</label><select id="slTrg" data-sl-in="trigger" aria-label="Reveal when this item is clicked">' + trigOptions(slide, it) + "</select></div>" +
      '<p class="hint">Or choose an item here: this one stays hidden until that item is clicked in the slide show, in any order. It then ignores the click number.</p>' +
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
  function redrawProps() { var p = $("#slProps"); if (p) { p.innerHTML = propsHTML(); wireProps(p); } }
  function markSel() {
    var c = SL.cur, box = $("#slCanvas"); if (!box || box.getAttribute("data-edit") !== "1") return;
    var ids = selIds();
    $$(".sl-it", box).forEach(function (n) { n.classList.toggle("sel", ids.indexOf(n.getAttribute("data-id")) >= 0); var h = $(".sl-rs", n); if (h) h.remove(); });
    var n = ids.length === 1 && $('.sl-it[data-id="' + c.sel + '"]', box);
    if (n) { var h = document.createElement("span"); h.className = "sl-rs"; n.appendChild(h); }
    animBadges(box);
  }
  /* editor only: a small numbered box on every item that appears on a click, like PowerPoint's animation pane.
     The badges live on the stage (not inside the items), so they never reach the saved text, the thumbnails or the show. */
  function animBadges(box) {
    var stage = $(".sl-stage", box); if (!stage) return;
    $$(".sl-anim", stage).forEach(function (b) { b.remove(); });
    (curSlide().items || []).forEach(function (it) {
      var trg = it.trigger && it.trigger !== it.id && (curSlide().items || []).some(function (o) { return o.id === it.trigger; });
      if (!it.step && !trg) return;
      var b = document.createElement("span"); b.className = "sl-anim" + (trg ? " trg" : ""); b.textContent = trg ? "\u25B6" : it.step; if (trg) b.title = "Appears when another item is clicked";
      b.style.left = it.x * PX + "px"; b.style.top = it.y * PX + "px"; stage.appendChild(b);
    });
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
    var c = SL.cur, its = selItems(); snap();
    if (name === "bg") curSlide().bg = v;
    else if (!its.length) return;
    else its.forEach(function (it) {
      if (name === "tc") eachRun(it, function (r) { r.c = v; });
      else if (name === "fill") it.fill = v || null;
      else if (name === "line") { if (v) { it.line = v; it.lw = it.lw || 2; } else { delete it.line; } }
    });
    dirty(); redrawCanvas(); redrawProps();
  }
  function setIn(el) {
    var c = SL.cur, k = el.getAttribute("data-sl-in"), it = selItem(), v = el.value;
    if (k === "note") { c.notes[curSlide().id] = v; dirty(); return; }
    if (k === "tr") { snap(); curSlide().tr = v; dirty(); return; }
    if (!it) return;
    if (el.getAttribute("data-typing") !== "1") { snap(); el.setAttribute("data-typing", "1"); }
    if (k === "step" || k === "fx") { selItems().forEach(function (o) { if (k === "step") o.step = Math.max(0, parseInt(v, 10) || 0); else o.fx = v; }); dirty(); redrawCanvas(); return; }
    if (k === "trigger") { if (v) { it.trigger = v; it.step = 0; if (!it.fx) it.fx = "fade"; } else delete it.trigger; dirty(); redrawCanvas(); redrawProps(); return; }
    if (k === "text") setText(it, v);
    else if (k === "size") eachRun(it, function (r) { r.sz = Math.max(6, Number(v) || 18); });
    else if (k === "align") (it.paras || []).forEach(function (p) { p.al = v; });
    else if (k === "anchor") it.anchor = v;
    else if (k === "shape") { it.shape = v; if (v === "round" && it.rad == null) it.rad = 0.2; }
    else if (k === "label") it.label = v;
    else if (k === "vfrom") { var f0 = parseT(v); if (f0) it.from = f0; else delete it.from; }
    else if (k === "vkeep") { v = v.trim(); if (v) it.keep = v; else delete it.keep; }
    else if (k === "vto") { var t0 = parseT(v); if (t0) it.to = t0; else delete it.to; }
    else if (k === "step") it.step = Math.max(0, parseInt(v, 10) || 0);
    else if (k === "fx") it.fx = v;
    else if (k === "pos") it[el.getAttribute("data-k")] = Number(v) || 0;
    dirty(); redrawCanvas(); if (k === "step" || k === "fx") { /* keep focus in the field */ }
  }

  /* ------------------------------------------------------------ pointer: select, move, resize */
  var drag = null;
  function wireApp(el) {
    var cv = $("#slCanvas", el);
    if (cv && cv.getAttribute("data-edit") === "1") { markSel(); cv.addEventListener("pointerdown", onDown); cv.addEventListener("dblclick", onDbl); }
    else if (cv) cv.addEventListener("click", function (e) { trigClick(e, cv); });
    wireProps(el);
  }
  /* the properties panel is re-rendered whenever the selection changes, so its fields must be wired again each time */
  function wireProps(el) {
    $$("input[data-sl-file]", el).forEach(function (inp) { inp.addEventListener("change", onFile); });
    $$("[data-sl-in]", el).forEach(function (n) {
      n.addEventListener(n.tagName === "SELECT" ? "change" : "input", function () { setIn(n); });
      n.addEventListener("blur", function () { n.removeAttribute("data-typing"); });
    });
  }
  function onDown(e) {
    var c = SL.cur, cv = e.currentTarget, tgt = e.target, itEl = tgt.closest(".sl-it"), box = cv.getBoundingClientRect(), scale = box.width / (W * PX);
    if (editing) {
      if (itEl && itEl === editing.n) return; /* clicking inside the text being edited: let the caret move */
      finishEdit(); tgt = document.elementFromPoint(e.clientX, e.clientY) || tgt; itEl = tgt.closest && tgt.closest(".sl-it");
    }
    var multiKey = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!itEl) { if (c.sel && !multiKey) { c.sel = null; markSel(); redrawProps(); } return; }
    var id = itEl.getAttribute("data-id"), it = curSlide().items.filter(function (i) { return i.id === id; })[0]; if (!it) return;
    if (tgt.closest(".sl-aud")) e.preventDefault();
    var ids = selIds();
    if (multiKey) { /* Ctrl or Shift + click: add the item to the selection, or take it out */
      var at = ids.indexOf(id); if (at >= 0) ids.splice(at, 1); else ids.push(id);
      setSelIds(ids); markSel(); redrawProps(); e.preventDefault(); return;
    }
    var inGroup = ids.length > 1 && ids.indexOf(id) >= 0; /* pressing on an item of the selection keeps it and drags them all */
    if (!inGroup) { var selChanged = c.sel !== id || ids.length > 1; setSelIds([id]); markSel(); if (selChanged) redrawProps(); }
    var resize = !inGroup && !!tgt.closest(".sl-rs");
    var group = (inGroup ? selItems() : [it]).map(function (o) { return { it: o, ox: o.x, oy: o.y, el: $('.sl-it[data-id="' + o.id + '"]', cv) }; });
    drag = { it: it, group: group, inGroup: inGroup, resize: resize, sx: e.clientX, sy: e.clientY, ox: it.x, oy: it.y, ow: it.w, oh: it.h, scale: scale, moved: false, el: itEl };
    cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
    cv.addEventListener("pointermove", onMove); cv.addEventListener("pointerup", onUp); cv.addEventListener("pointercancel", onUp);
    e.preventDefault();
  }
  /* ---- type directly on the slide: double-click a text item */
  var editing = null;
  function itemText(n) {
    var lines = [];
    Array.prototype.forEach.call(n.childNodes, function (ch) {
      var t;
      if (ch.nodeType === 1) { if (ch.classList.contains("sl-rs")) return; t = ch.textContent; }
      else if (ch.nodeType === 3) t = ch.nodeValue; else return;
      lines.push(t === "\u00a0" ? "" : t.replace(/\u00a0/g, " ").replace(/\n/g, " "));
    });
    return lines.join("\n");
  }
  function onDbl(e) {
    var c = SL.cur, t = document.elementFromPoint(e.clientX, e.clientY), n = t && t.closest && t.closest(".sl-it"); /* the canvas holds pointer capture, so e.target is the canvas */ if (!c || c.mode !== "edit" || !n) return;
    var id = n.getAttribute("data-id"), it = curSlide().items.filter(function (i) { return i.id === id; })[0];
    if (!it || (it.t !== "text" && it.t !== "box") || (editing && editing.n === n)) return;
    drag = null; if (c.sel !== id || selIds().length > 1) { setSelIds([id]); markSel(); redrawProps(); }
    startEdit(n, it);
  }
  function startEdit(n, it) {
    if (editing) finishEdit();
    editing = { n: n, it: it, changed: false };
    var h = $(".sl-rs", n); if (h) h.remove();
    n.setAttribute("contenteditable", "true"); n.setAttribute("data-editing", "1"); n.spellcheck = false;
    n.addEventListener("input", onEditInput); n.addEventListener("keydown", onEditKey); n.addEventListener("paste", onEditPaste); n.addEventListener("blur", finishEdit);
    n.focus();
    var sel = window.getSelection(), r = document.createRange(); r.selectNodeContents(n); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  }
  function onEditInput() {
    if (!editing) return;
    if (!editing.changed) { snap(); editing.changed = true; }
    var t = itemText(editing.n); setText(editing.it, t); dirty();
    var tx = $("#slTx"); if (tx) tx.value = t;
  }
  function onEditKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.target.blur(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); return; }
    e.stopPropagation();
  }
  function onEditPaste(e) {
    e.preventDefault();
    var t = ((e.clipboardData || window.clipboardData).getData("text") || "").replace(/\r/g, "");
    document.execCommand("insertText", false, t);
  }
  function finishEdit() {
    if (!editing) return;
    var ed = editing; editing = null;
    ed.n.removeEventListener("input", onEditInput); ed.n.removeEventListener("keydown", onEditKey); ed.n.removeEventListener("paste", onEditPaste); ed.n.removeEventListener("blur", finishEdit);
    ed.n.removeAttribute("contenteditable"); ed.n.removeAttribute("data-editing");
    if (!SL.cur) return;
    redrawCanvas();
  }
  function onMove(e) {
    if (!drag) return;
    var dx = (e.clientX - drag.sx) / drag.scale / PX, dy = (e.clientY - drag.sy) / drag.scale / PX;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 0.04) return;
    if (!drag.moved) { snap(); drag.moved = true; }
    var g = function (v) { return Math.round(v * 20) / 20; };
    if (drag.resize) { drag.it.w = Math.max(0.3, g(drag.ow + dx)); drag.it.h = Math.max(0.2, g(drag.oh + dy)); }
    else drag.group.forEach(function (o) { o.it.x = g(o.ox + dx); o.it.y = g(o.oy + dy); });
    (drag.resize ? [{ it: drag.it, el: drag.el }] : drag.group).forEach(function (o) { var n = o.el; if (!n) return; n.style.left = o.it.x * PX + "px"; n.style.top = o.it.y * PX + "px"; n.style.width = o.it.w * PX + "px"; n.style.height = o.it.h * PX + "px"; });
  }
  function onUp(e) {
    var cv = e.currentTarget; cv.removeEventListener("pointermove", onMove); cv.removeEventListener("pointerup", onUp); cv.removeEventListener("pointercancel", onUp);
    if (drag && drag.moved) { dirty(); redrawCanvas(); redrawProps(); }
    else if (drag && drag.inGroup) { setSelIds([drag.it.id]); markSel(); redrawProps(); } /* a plain click on one of several selected items selects just that one */
    drag = null;
  }
  document.addEventListener("keydown", function (e) {
    var c = SL.cur; if (!c || !$("#slApp") || SL.show) return;
    if (e.target.isContentEditable) return; var tag = (e.target.tagName || "").toLowerCase(); if (tag === "input" || tag === "textarea" || tag === "select") { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); } return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && c.mode === "edit") { e.preventDefault(); undo(); return; }
    if (e.key === "Escape") { closeApp(); return; }
    if (e.key === "ArrowRight" && !c.sel) { go(1); return; }
    if (e.key === "ArrowLeft" && !c.sel) { go(-1); return; }
    var it = selItem(), mod = e.ctrlKey || e.metaKey, ek = (e.key || "").toLowerCase();
    if (c.mode === "edit") {
      if (mod && ek === "a") { e.preventDefault(); var all = curSlide().items.map(function (i) { return i.id; }); setSelIds(all); markSel(); redrawProps(); return; }
      if (mod && (ek === "c" || ek === "x") && it) { e.preventDefault(); copyItems(ek === "x"); return; }
    }
    if (c.mode === "edit" && !it && e.key === "Delete" && !mod && !e.altKey) { e.preventDefault(); delSlide(false); return; } /* nothing selected on the slide: Delete removes the slide itself (Undo brings it back) */
    if (it && c.mode === "edit") {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); delItem(); return; }
      var st = e.shiftKey ? 0.25 : 0.05, m = { ArrowLeft: ["x", -st], ArrowRight: ["x", st], ArrowUp: ["y", -st], ArrowDown: ["y", st] }[e.key];
      if (m) { e.preventDefault(); snap(); selItems().forEach(function (o) { o[m[0]] = Math.round((o[m[0]] + m[1]) * 20) / 20; }); dirty(); redrawCanvas(); redrawProps(); }
    }
  });

  /* Ctrl+V while editing: slide items copied here, or a picture or text from anywhere else on the computer */
  window.addEventListener("blur", function () { if (clip) clip.away = true; });
  document.addEventListener("paste", function (e) {
    var c = SL.cur; if (!c || !$("#slApp") || SL.show || c.mode !== "edit") return;
    var t = e.target; if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ""))) return;
    var cd = e.clipboardData; if (!cd) return;
    var file = null; Array.prototype.forEach.call(cd.items || [], function (i) { if (!file && i.kind === "file" && /^image\//.test(i.type)) file = i.getAsFile(); });
    var text = (cd.getData("text/plain") || "").replace(/\r/g, "");
    e.preventDefault();
    if (clip && clip.items.length && !clip.away) return pasteItems(); /* just copied inside the editor */
    if (file) { onFile({ target: { getAttribute: function () { return "img"; }, files: [file], value: "" } }); return; }
    if (text.trim()) { pasteText(text); return; }
    if (clip && clip.items.length) pasteItems(); else toast("Nothing to paste. Copy a picture or some text first.");
  });
  function pasteText(text) {
    var c = SL.cur, it = newItem("text"), lines = text.replace(/\s+$/, "").split("\n"), rows = 0;
    lines.forEach(function (ln) { rows += Math.max(1, Math.ceil(ln.length / 48)); });
    it.w = lines.length === 1 && text.length < 30 ? 5 : 8; it.h = Math.min(6, Math.round((rows * 0.45 + 0.15) * 20) / 20); it.y = 1.6;
    snap(); setText(it, lines.join("\n")); curSlide().items.push(it); c.sel = it.id; dirty(); redrawCanvas(); redrawProps(); toast("Text pasted.");
  }

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
  /* reads a video's picture size so the new item has the right shape; null if the browser cannot read it */
  function probeVideo(file) {
    return new Promise(function (res) {
      var v = document.createElement("video"), url = URL.createObjectURL(file), done = function (d) { URL.revokeObjectURL(url); res(d); };
      v.preload = "metadata"; v.muted = true;
      v.onloadedmetadata = function () { done(v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : null); };
      v.onerror = function () { done(null); };
      setTimeout(function () { done(null); }, 6000);
      v.src = url;
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
    if (kind === "vid" || kind === "vidfor") {
      var vext = (file.name.split(".").pop() || "").toLowerCase();
      if (vext !== "mp4" && vext !== "m4v") { toast("Video must be an mp4 file (H.264). Other formats can be converted to mp4 with a free tool such as HandBrake.", true); return; }
      if (file.size > 50 * 1024 * 1024) { toast("Videos can be up to 50 MB. Shrink it first (for example 720p in HandBrake).", true); return; }
      toast("Uploading video… this can take a minute.");
      var vpath = "decks/" + c.id + "/" + uid() + ".mp4", dims = { w: 16, h: 9 };
      probeVideo(file).then(function (d) { if (d) dims = d; }).then(function () {
        return sb.storage.from("materials").upload(vpath, file, { contentType: "video/mp4", upsert: false });
      }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return sb.from("deck_assets").insert({ deck_id: c.id, kind: "video", name: file.name, mime: "video/mp4", file_path: vpath }).select("*").single();
      }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        c.assets[r.data.id] = r.data; snap();
        if (kind === "vidfor" && selItem()) { var si = selItem(); si.src = r.data.id; delete si.from; delete si.to; }
        else {
          var vw = 8, vh2 = vw * dims.h / dims.w; if (vh2 > 5.2) { vh2 = 5.2; vw = vh2 * dims.w / dims.h; }
          var vi = { id: sid(), t: "video", x: Math.round((W - vw) / 2 * 20) / 20, y: 1.3, w: Math.round(vw * 20) / 20, h: Math.round(vh2 * 20) / 20, step: 0, label: "Video", src: r.data.id };
          curSlide().items.push(vi); c.sel = vi.id;
        }
        dirty(); redrawCanvas(); redrawProps(); toast("Video added. Press Save to keep it.");
      }).catch(function (er) { toast(er.message || "Upload failed.", true); });
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
  /* after copying items, a trigger follows its copied trigger item; one pointing at an item that is not on the destination slide is dropped */
  function remapTrig(fresh, idm, dest) {
    var have = {}; dest.forEach(function (i) { have[i.id] = 1; });
    fresh.forEach(function (i) { if (!i.trigger) return; if (idm[i.trigger]) i.trigger = idm[i.trigger]; else if (!have[i.trigger]) delete i.trigger; });
  }
  function delItem() { var c = SL.cur, s = curSlide(), ids = selIds(); if (!ids.length) return; snap(); s.items = s.items.filter(function (i) { return ids.indexOf(i.id) < 0; }); s.items.forEach(function (i) { if (i.trigger && ids.indexOf(i.trigger) >= 0) delete i.trigger; }); c.sel = null; dirty(); redrawCanvas(); redrawProps(); }
  /* copy, cut and paste items (also onto another slide) */
  function copyItems(cut) {
    var its = selItems(); if (!its.length) return;
    clip = { items: clone(its), n: 0 };
    if (cut) { delItem(); toast(its.length > 1 ? "Cut " + its.length + " items." : "Cut."); } else toast(its.length > 1 ? "Copied " + its.length + " items." : "Copied.");
  }
  function pasteItems() {
    var c = SL.cur; if (!clip || !clip.items.length) return;
    clip.n++; var off = Math.min(clip.n, 8) * 0.3, ids = [], s = curSlide(), put = [], idm = {};
    clip.items.forEach(function (o) {
      if ((o.t === "img" || o.t === "audio" || o.t === "video") && o.src && !c.assets[o.src]) return; /* its file belongs to another deck */
      var d = clone(o); idm[o.id] = d.id = sid(); d.x = Math.round(Math.max(0, Math.min(13.33 - d.w, d.x + off)) * 20) / 20; d.y = Math.round(Math.max(0, Math.min(7.5 - d.h, d.y + off)) * 20) / 20; put.push(d); ids.push(d.id);
    });
    if (!put.length) return toast("Those items can't be pasted into this deck.");
    remapTrig(put, idm, s.items); snap(); put.forEach(function (d) { s.items.push(d); }); setSelIds(ids); dirty(); redrawCanvas(); redrawProps();
  }
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
    if (a === "dupslide") { snap(); var cp = clone(curSlide()); cp.id = "s" + Math.random().toString(36).slice(2, 8); var idm = {}; cp.items.forEach(function (i) { var n = sid(); idm[i.id] = n; i.id = n; }); remapTrig(cp.items, idm, cp.items); c.notes[cp.id] = c.notes[curSlide().id] || ""; c.slides.splice(c.idx + 1, 0, cp); c.idx++; dirty(); return refreshApp(); }
    if (a === "delslide") return delSlide(true);
    if (a === "up" || a === "down") { var j = c.idx + (a === "up" ? -1 : 1); if (j < 0 || j >= c.slides.length) return; snap(); var t = c.slides[c.idx]; c.slides[c.idx] = c.slides[j]; c.slides[j] = t; c.idx = j; dirty(); return refreshApp(); }
    if (a === "addtext" || a === "addbox") { snap(); var it = newItem(a === "addtext" ? "text" : "box"); curSlide().items.push(it); c.sel = it.id; dirty(); redrawCanvas(); return redrawProps(); }
    if (a === "delitem") return delItem();
    if (a === "dupitem") { var s0 = selItems(); if (!s0.length) return; snap(); var nids = [], dm = {}, fresh = []; s0.forEach(function (o) { var d = clone(o); dm[o.id] = d.id = sid(); d.x += 0.3; d.y += 0.3; curSlide().items.push(d); nids.push(d.id); fresh.push(d); }); remapTrig(fresh, dm, curSlide().items); setSelIds(nids); dirty(); redrawCanvas(); return redrawProps(); }
    if (a === "front" || a === "back") { var s1 = selItems(); if (!s1.length) return; snap(); var arr = curSlide().items.filter(function (i) { return s1.indexOf(i) < 0; }); curSlide().items = a === "front" ? arr.concat(s1) : s1.concat(arr); dirty(); return redrawCanvas(); }
    if (a === "bold") { var s2 = selItem(); if (!s2) return; snap(); var on = !(s2.paras && s2.paras[0] && s2.paras[0].runs[0] && s2.paras[0].runs[0].b); eachRun(s2, function (r) { if (on) r.b = 1; else delete r.b; }); dirty(); redrawCanvas(); return redrawProps(); }
    if (a === "color") return setCol(b.getAttribute("data-name"), b.getAttribute("data-v"));
    if (a === "rmaudio") { var s3 = selItem(); if (!s3) return; snap(); s3.src = null; dirty(); redrawCanvas(); return redrawProps(); }
  }
  function delSlide(ask) {
    var c = SL.cur; if (!c || c.mode !== "edit") return;
    if (c.slides.length < 2) return toast("A deck needs at least one slide.");
    if (ask && !window.confirm("Delete this slide?")) return;
    snap(); var i = c.idx; c.slides.splice(i, 1); c.idx = Math.min(i, c.slides.length - 1); c.sel = null; dirty(); refreshApp();
    if (!ask) toast("Slide " + (i + 1) + " deleted. Ctrl+Z or Undo brings it back.");
  }
  /* drag a slide in the list to move it before or after another one */
  var thDrag = null;
  function thSide(box, th, e) { /* "before" or "after" the slide under the pointer, along the list's own direction */
    var r = th.getBoundingClientRect(), row = getComputedStyle(box).flexDirection.indexOf("row") === 0;
    return (row ? e.clientX - r.left < r.width / 2 : e.clientY - r.top < r.height / 2) ? "before" : "after";
  }
  function thClear() { $$("#slThumbs .sl-th").forEach(function (t) { t.classList.remove("dbefore", "dafter", "dragging"); }); }
  document.addEventListener("dragstart", function (e) {
    var th = e.target.closest && e.target.closest("#slThumbs .sl-th[draggable]"); if (!th || !SL.cur || SL.cur.mode !== "edit") return;
    thDrag = Number(th.getAttribute("data-i")); th.classList.add("dragging");
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "slide " + (thDrag + 1)); } catch (x) { /* ignore */ }
  });
  document.addEventListener("dragover", function (e) {
    if (thDrag == null) return; var box = $("#slThumbs"); if (!box) return;
    var th = e.target.closest && e.target.closest("#slThumbs .sl-th"); e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (x) { /* ignore */ }
    var br = box.getBoundingClientRect(), row = getComputedStyle(box).flexDirection.indexOf("row") === 0; /* near an edge of the list: scroll it */
    if (row) { if (e.clientX < br.left + 30) box.scrollLeft -= 14; else if (e.clientX > br.right - 30) box.scrollLeft += 14; } else { if (e.clientY < br.top + 40) box.scrollTop -= 16; else if (e.clientY > br.bottom - 40) box.scrollTop += 16; }
    $$("#slThumbs .sl-th").forEach(function (t) { t.classList.remove("dbefore", "dafter"); });
    if (th) th.classList.add(thSide(box, th, e) === "before" ? "dbefore" : "dafter");
  });
  document.addEventListener("drop", function (e) {
    if (thDrag == null) return; var c = SL.cur, box = $("#slThumbs"), th = e.target.closest && e.target.closest("#slThumbs .sl-th"), from = thDrag; thDrag = null;
    e.preventDefault(); if (!c || !box || !th) { thClear(); return; }
    var to = Number(th.getAttribute("data-i")) + (thSide(box, th, e) === "after" ? 1 : 0); if (from < to) to--; thClear();
    if (to === from || to < 0 || to >= c.slides.length) return;
    snap(); var m = c.slides.splice(from, 1)[0]; c.slides.splice(to, 0, m); c.idx = to; c.sel = null; dirty(); refreshApp();
  });
  document.addEventListener("dragend", function () { thDrag = null; thClear(); });
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("sl-th")) { e.preventDefault(); slAct("goto", e.target); }
  });
  document.addEventListener("click", function (e) {
    var au = e.target.closest("[data-aud]");
    if (au && (e.target.closest("#slApp") || e.target.closest("#slShow"))) { e.preventDefault(); toggleAudio(au.getAttribute("data-aud")); return; }
    var b = e.target.closest("#slApp [data-sl]"); if (!b) return;
    slAct(b.getAttribute("data-sl"), b);
  });

  /* ------------------------------------------------------------ audio (one player, works inside and outside the slide show) */
  var curAud = null;      // { id, label }
  function findItem(id) { /* the audio item with this id, looking at the slide on screen first (item ids repeat between slides) */
    var c = SL.cur || SL.show; if (!c) return null;
    var n = c.slides.length, start = SL.show ? SL.show.idx : c.idx;
    for (var k = 0; k < n; k++) { var sl = c.slides[(start + k) % n]; var f = ((sl && sl.items) || []).filter(function (x) { return x.id === id && x.t === "audio"; })[0]; if (f) return f; }
    return null;
  }
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
  /* ------------------------------------------------------------ video: a <video> in the slide, optionally trimmed (it.from / it.to, in seconds).
     The file is a private mp4 in the 'materials' bucket; a signed link is made when the slide is drawn. Only one thing plays at a time (audio or video). */
  var vurl = {};
  function assetOf(id) { return (SL.show && SL.show.assets && SL.show.assets[id]) || (SL.cur && SL.cur.assets && SL.cur.assets[id]) || null; }
  function videoUrl(aid) {
    var h = vurl[aid]; if (h && h.exp > Date.now()) return h.p;
    var as = assetOf(aid); if (!as || !as.file_path) return Promise.reject(new Error("This video is not available."));
    var p = A().sb.storage.from("materials").createSignedUrl(as.file_path, 3600).then(function (r) {
      if (r.error || !r.data) throw new Error((r.error && r.error.message) || "This video is not available.");
      return r.data.signedUrl;
    });
    vurl[aid] = { p: p, exp: Date.now() + 50 * 60 * 1000 }; p.catch(function () { delete vurl[aid]; });
    return p;
  }
  function vidRoot() { return (SL.show && $("#slSbox")) || document; } /* during the slide show only the slide on screen counts, not the viewer behind it */
  function allVideos() { return $$("video.sl-vid", vidRoot()); }
  function playingVideo() { return allVideos().filter(function (v) { return !v.paused && !v.ended; })[0] || null; }
  function syncVidUI() {
    var on = !!playingVideo();
    $$("[data-vid]").forEach(function (b) { b.classList.toggle("playing", on); var ic = $(".sl-vid-bi", b); if (ic) ic.innerHTML = on ? "&#10074;&#10074;" : "&#9654;"; });
  }
  function hydrateVideos(root) {
    $$("video.sl-vid:not([data-ready])", root || document).forEach(function (v) {
      v.setAttribute("data-ready", "1");
      var watch = null;
      function F() { return Number(v.getAttribute("data-from")) || 0; }
      function T() { return Number(v.getAttribute("data-to")) || 0; }
      function stopWatch() { if (watch) { clearInterval(watch); watch = null; } }
      v.addEventListener("loadedmetadata", function () { if (F() > 0 && v.currentTime < F()) { try { v.currentTime = F(); } catch (x) { /* not seekable yet */ } } });
      v.addEventListener("play", function () {
        try { audio.pause(); } catch (x) { /* none */ }
        v._stopped = false;
        if (T() && v.currentTime >= T() - 0.15) v.currentTime = F(); else if (v.currentTime < F() - 0.3) v.currentTime = F(); /* replay from the start point */
        $$("video.sl-vid").forEach(function (o) { if (o !== v && !o.paused) o.pause(); });
        stopWatch(); watch = setInterval(function () { if (T() && v.currentTime >= T()) { v._stopped = true; v.pause(); stopWatch(); } }, 40); /* pauses within a fraction of a second of the stop point */
        syncVidUI();
      });
      ["pause", "ended", "emptied"].forEach(function (ev) { v.addEventListener(ev, function () { stopWatch(); syncVidUI(); }); });
      v.addEventListener("error", function () { if (v.getAttribute("src")) toast("The video could not be played. It must be an mp4 (H.264).", true); });
      videoUrl(v.getAttribute("data-vsrc")).then(function (u) { v.src = u; }).catch(function (e) { toast(e.message || "The video could not be loaded.", true); });
    });
  }
  function toggleVideo(itemId) {
    var v = null;
    if (itemId) { var box = $$(".sl-video", vidRoot()).filter(function (n) { return n.getAttribute("data-id") === itemId; })[0]; v = box && $("video.sl-vid", box); }
    if (!v) v = playingVideo() || allVideos()[0]; if (!v) return;
    if (v.paused) { var pr = v.play(); if (pr && pr.catch) pr.catch(function () { /* blocked or not loaded yet */ }); } else v.pause();
  }
  if (window.MutationObserver) new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) for (var j = 0; j < muts[i].addedNodes.length; j++) {
      var n = muts[i].addedNodes[j]; if (n.nodeType === 1 && ((n.matches && n.matches("video.sl-vid")) || (n.querySelector && n.querySelector("video.sl-vid")))) { hydrateVideos(n.parentNode || document); return; }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  audio.addEventListener("play", function () { $$("video.sl-vid").forEach(function (v) { if (!v.paused) v.pause(); }); });
  function syncAudioUI() {
    var playing = !audio.paused && !!curAud;
    $$("[data-aud]").forEach(function (n) { var on = playing && curAud && n.getAttribute("data-aud") === curAud.id; var ic = $(".sl-aud-ic", n); if (ic) ic.innerHTML = on ? "&#10074;&#10074;" : "&#9654;"; n.classList.toggle("playing", !!on); });
    if (!mini) {
      mini = document.createElement("div"); mini.id = "slMini"; mini.className = "slmini"; mini.hidden = true; (document.fullscreenElement || document.body).appendChild(mini);
      mini.innerHTML = '<div class="sl-mini-top" title="Drag to move. Double-click to put it back."><span class="sl-mini-grip" aria-hidden="true">&#8942;&#8942;</span><span class="sl-mini-t"></span><button type="button" class="btn sm sec" data-m="x" aria-label="Stop audio">Stop</button></div>' +
        '<div class="sl-mini-bar"><button type="button" class="btn sm sec" data-m="back" aria-label="Back 10 seconds">&minus;10s</button><button type="button" class="btn sm" data-m="pp" aria-label="Play or pause">Pause</button><button type="button" class="btn sm sec" data-m="fwd" aria-label="Forward 10 seconds">+10s</button>' +
        '<span class="sl-mini-time" data-m="cur">0:00</span><input type="range" class="sl-mini-seek" min="0" max="1000" value="0" step="1" aria-label="Playback position"><span class="sl-mini-time" data-m="dur">0:00</span></div>';
      mini.addEventListener("keydown", function (e) { e.stopPropagation(); });
      mini.addEventListener("click", function (e) {
        var b = e.target.closest("button"); if (!b) return; if (e.detail > 0) b.blur(); var m = b.getAttribute("data-m"), d = audio.duration || 0;
        if (m === "pp") { if (audio.paused) audio.play(); else audio.pause(); }
        else if (m === "back") audio.currentTime = Math.max(0, audio.currentTime - 10);
        else if (m === "fwd") audio.currentTime = d ? Math.min(d, audio.currentTime + 10) : audio.currentTime + 10;
        else { audio.pause(); audio.removeAttribute("src"); audio.load(); curAud = null; syncAudioUI(); }
      });
      var sk = mini.querySelector(".sl-mini-seek");
      sk.addEventListener("input", function () { seeking = true; var d = audio.duration || 0; if (d) { audio.currentTime = sk.value / 1000 * d; } miniTime(); });
      sk.addEventListener("change", function () { seeking = false; });
      sk.addEventListener("pointerup", function () { seeking = false; sk.blur(); });
    }
    if (curAud && audio.src) {
      mini.hidden = false; mini.querySelector(".sl-mini-t").textContent = curAud.label;
      var pp = mini.querySelector('[data-m="pp"]'); pp.textContent = playing ? "Pause" : "Play"; miniTime();
    } else mini.hidden = true;
  }
  var seeking = false;
  function fmtT(t) { t = Math.max(0, Math.floor(t || 0)); var m = Math.floor(t / 60), s = t % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
  function miniTime() {
    if (!mini || mini.hidden && !curAud) return;
    var d = audio.duration, t = audio.currentTime || 0, fin = isFinite(d) && d > 0;
    mini.querySelector('[data-m="cur"]').textContent = fmtT(t); mini.querySelector('[data-m="dur"]').textContent = fin ? fmtT(d) : "--:--";
    var sk = mini.querySelector(".sl-mini-seek"); if (fin && !seeking) sk.value = String(Math.round(t / d * 1000));
  }
  ["timeupdate", "loadedmetadata", "durationchange", "seeked"].forEach(function (ev) { audio.addEventListener(ev, miniTime); });
  ["play", "pause", "ended", "emptied"].forEach(function (ev) { audio.addEventListener(ev, syncAudioUI); });

  /* ------------------------------------------------------------ slide show */
  function startShow() {
    var c = SL.cur; if (!c) return;
    $$("video.sl-vid").forEach(function (v) { if (!v.paused) v.pause(); });
    SL.show = { slides: c.slides, assets: c.assets, notes: c.notes, idx: c.idx, step: 0, fromEdit: c.mode, ctlF: ctlLoad() };
    var el = $("#slShow"); if (el) el.remove();
    el = document.createElement("div"); el.id = "slShow"; el.className = "slshow"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Slide show");
    document.body.appendChild(el);
    el.innerHTML = '<div class="sl-sbox" id="slSbox"></div><div class="sl-ctl" id="slCtl"><span class="sl-ctl-grip" id="slCtlGrip" title="Drag to move the bar up or down" aria-label="Drag to move the control bar" role="img">&#8942;&#8942;</span><button type="button" data-sh="flip" id="slCtlFlip" class="btn sm sec" title="Move bar to top" aria-label="Move bar to top">&#8593;</button><button type="button" data-sh="prev" class="btn sm sec" aria-label="Previous">&larr;</button><span id="slCnt"></span><button type="button" data-sh="next" class="btn sm sec" aria-label="Next">&rarr;</button><button type="button" data-sh="zout" id="slZOut" class="btn sm sec" title="Zoom out (-)" aria-label="Zoom out">&minus;</button><button type="button" data-sh="zreset" id="slZRes" class="btn sm sec" title="Back to 100% (0)" aria-label="Reset zoom to 100%">100%</button><button type="button" data-sh="zin" id="slZIn" class="btn sm sec" title="Zoom in (+)" aria-label="Zoom in">+</button><span id="slAudCtl"></span><button type="button" data-sh="full" class="btn sm sec">Full screen</button><button type="button" data-sh="exit" class="btn sm">Exit</button></div>';
    inkInit(el); widInit(el); ctlWire(el); zoomWire(el);
    el.addEventListener("click", onShowClick);
    document.addEventListener("keydown", onShowKey, true);
    window.addEventListener("resize", showFit);
    drawShow("none");
    enterFs(el);
    document.addEventListener("fullscreenchange", onFsChange);
  }
  /* Esc normally leaves full screen before the page sees it. Keyboard Lock (Chrome, Edge) hands Esc to the page, so the first Esc stops
     drawing and the next one exits the show; holding Esc still leaves full screen. Other browsers fall back to onFsChange below. */
  function enterFs(el) {
    if (!el || !el.requestFullscreen) return;
    el.requestFullscreen().then(function () {
      try { if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(["Escape"]).catch(function () {}); } catch (x) { /* optional */ }
    }).catch(function () { /* stays in the page */ });
  }
  function onFsChange() {
    if (mini) (document.fullscreenElement || document.body).appendChild(mini); /* the audio bar must stay visible in full screen */
    if (!document.fullscreenElement) {
      try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch (x) { /* optional */ }
      if (SL.show && SL.show.tool) inkTool(SL.show.tool); /* leaving full screen also puts the pen down */
    }
    showFit();
  }
  /* zoom: the slide is scaled about the middle of the screen and can be dragged around; drawings and stamps use the same transform, so they zoom with the slide */
  var ZOOMS = [1, 1.25, 1.5, 2, 2.5, 3, 4];
  function showXf() {
    var box = $("#slSbox"), sh = SL.show, z = (sh && sh.zoom) || 1, s = Math.min(box.clientWidth / (W * PX), box.clientHeight / (H * PX)) * z;
    var mx = Math.max(0, (W * PX * s - box.clientWidth) / 2), my = Math.max(0, (H * PX * s - box.clientHeight) / 2);
    var px = Math.max(-mx, Math.min(mx, (sh && sh.px) || 0)), py = Math.max(-my, Math.min(my, (sh && sh.py) || 0));
    return { s: s, ox: (box.clientWidth - W * PX * s) / 2 + px, oy: (box.clientHeight - H * PX * s) / 2 + py, px: px, py: py, z: z };
  }
  function showFit() {
    var box = $("#slSbox"); if (!box) return; var st = box.firstElementChild; if (!st) return;
    var x = showXf(); if (SL.show) { SL.show.px = x.px; SL.show.py = x.py; }
    st.style.transform = "scale(" + x.s + ")"; st.style.left = x.ox + "px"; st.style.top = x.oy + "px"; zoomUI(); inkSize(); inkTxPlace(); ctlApply();
  }
  function zoomUI() {
    var sh = SL.show, z = (sh && sh.zoom) || 1, r = $("#slZRes"), i = $("#slZIn"), o = $("#slZOut"), box = $("#slSbox");
    if (r) r.textContent = Math.round(z * 100) + "%"; if (i) i.disabled = z >= ZOOMS[ZOOMS.length - 1] - 0.001; if (o) o.disabled = z <= 1.001; if (box) box.classList.toggle("zoomed", z > 1.001);
  }
  function zoomTo(z) {
    var sh = SL.show; if (!sh) return; z = Math.max(1, Math.min(ZOOMS[ZOOMS.length - 1], z)); var old = sh.zoom || 1;
    sh.px = (sh.px || 0) * z / old; sh.py = (sh.py || 0) * z / old; sh.zoom = z; if (z <= 1.001) { sh.px = 0; sh.py = 0; } showFit();
  }
  function zoomStep(d) {
    var z = (SL.show && SL.show.zoom) || 1, i;
    if (d > 0) { for (i = 0; i < ZOOMS.length; i++) if (ZOOMS[i] > z + 0.001) return zoomTo(ZOOMS[i]); }
    else for (i = ZOOMS.length - 1; i >= 0; i--) if (ZOOMS[i] < z - 0.001) return zoomTo(ZOOMS[i]);
  }
  function zoomWire(root) {
    var box = $("#slSbox", root); if (!box) return;
    box.addEventListener("pointerdown", function (e) { /* drag the zoomed slide; a plain click still works as before */
      var sh = SL.show; if (!sh) return; sh.noClick = 0; if ((sh.zoom || 1) <= 1.001 || e.button > 0) return;
      var sx = e.clientX, sy = e.clientY, p0x = sh.px || 0, p0y = sh.py || 0, moved = false;
      function mv(ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy; if (!moved && Math.hypot(dx, dy) < 6) return;
        if (!moved) { moved = true; box.classList.add("panning"); }
        sh.px = p0x + dx; sh.py = p0y + dy; showFit();
      }
      function up() { /* listeners sit on the document, so a drag that leaves the window still ends cleanly */
        document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up);
        box.classList.remove("panning"); if (moved) sh.noClick = Date.now();
      }
      document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up); document.addEventListener("pointercancel", up);
    });
    root.addEventListener("wheel", function (e) { /* trackpad pinch or Ctrl + wheel zooms; the wheel moves a zoomed slide */
      var sh = SL.show; if (!sh || (e.target.closest && e.target.closest(".sl-ctl, .sl-ink-bar, .sl-wid, .slmini"))) return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); var t = Date.now(); if (t - (sh.zT || 0) > 120) { sh.zT = t; zoomStep(e.deltaY < 0 ? 1 : -1); } return; }
      if ((sh.zoom || 1) > 1.001) { e.preventDefault(); sh.px = (sh.px || 0) - (e.shiftKey ? e.deltaY : e.deltaX); sh.py = (sh.py || 0) - (e.shiftKey ? 0 : e.deltaY); showFit(); }
    }, { passive: false });
  }
  function drawShow(how) {
    inkTxCommit();
    var sh = SL.show, slide = sh.slides[sh.idx], box = $("#slSbox"); if (!box) return;
    if (sh.zIdx !== sh.idx) { sh.zIdx = sh.idx; sh.zoom = 1; sh.px = 0; sh.py = 0; }
    var held = {}; $$("video.sl-vid[data-keep]", box).forEach(function (hv) { held[hv.getAttribute("data-keep")] = hv; }); /* a video on both slides keeps playing (see it.keep) */
    box.innerHTML = stageHTML(slide, { assets: sh.assets, step: sh.step, edit: false });
    $$("video.sl-vid[data-keep]", box).forEach(function (nv) { /* put the playing element into the new slide in the same task, so the browser never pauses it */
      var hv = held[nv.getAttribute("data-keep")]; if (!hv || hv.getAttribute("data-vsrc") !== nv.getAttribute("data-vsrc")) return;
      hv.setAttribute("data-from", nv.getAttribute("data-from")); hv.setAttribute("data-to", nv.getAttribute("data-to"));
      nv.parentNode.replaceChild(hv, nv);
      if (hv._stopped) { hv._stopped = false; var pr = hv.play(); if (pr && pr.catch) pr.catch(function () { /* needs a click */ }); } /* it had paused at its stop point: carry on */
    });
    var st = box.firstElementChild; st.classList.add("sl-pos"); showFit();
    var tr = how || slide.tr || "fade"; st.classList.add("tr-" + tr);
    $("#slCnt").textContent = (sh.idx + 1) + " / " + sh.slides.length + (maxStep(slide) ? "  ·  click " + sh.step + "/" + maxStep(slide) : "");
    var auds = (slide.items || []).filter(function (i) { return i.t === "audio" && i.src && sh.assets[i.src]; });
    var vids = (slide.items || []).filter(function (i) { return i.t === "video" && i.src && sh.assets[i.src]; });
    $("#slAudCtl").innerHTML = auds.map(function (i) { return '<button type="button" class="btn sm sec" data-aud="' + E(i.id) + '"><span class="sl-aud-ic">&#9654;</span> ' + E(i.label || "Listen") + "</button>"; }).join("") +
      vids.map(function (i) { return '<button type="button" class="btn sm sec" data-vid="' + E(i.id) + '" title="Play or pause the video (V)"><span class="sl-vid-bi">&#9654;</span> ' + E(i.label || "Video") + "</button>"; }).join("");
    syncAudioUI(); inkRedraw();
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
    var sh = SL.show; if (!sh) return; inkTxCancel();
    document.removeEventListener("keydown", onShowKey, true); window.removeEventListener("resize", showFit); document.removeEventListener("fullscreenchange", onFsChange);
    clearTimeout(ctlTimer);
    try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch (x) { /* optional */ }
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    var el = $("#slShow"); if (el) el.remove();
    widStop();
    if (SL.cur) { SL.cur.idx = sh.idx; }
    SL.show = null;
    if (SL.cur) refreshApp(); else { syncAudioUI(); }
  }
  function onShowKey(e) {
    if (!SL.show) return;
    var k = e.key;
    if (e.target && e.target.classList && e.target.classList.contains("sl-tx")) return; /* typing a label: the box has its own keys (Enter, Esc) */
    if (k !== "Escape" && e.target && e.target.closest && e.target.closest(".sl-wid, .slmini") && (k === " " || k === "Enter" || e.target.tagName === "INPUT")) return; /* Space and Enter press the focused timer, dice or audio button; the slider keeps its arrow keys */
    if ((k === " " || k === "Enter") && playingVideo()) { e.preventDefault(); e.stopPropagation(); playingVideo().pause(); return; } /* Space pauses a playing video instead of moving on */
    if (k === "ArrowRight" || k === "PageDown" || k === " " || k === "Enter") { e.preventDefault(); e.stopPropagation(); showNext(); }
    else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace") { e.preventDefault(); e.stopPropagation(); showPrev(); }
    else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); if (SL.show.tool) inkTool(SL.show.tool); else exitShow(); }
    else if ((k === "z" || k === "Z") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); inkUndo(); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && { p: "pen", h: "hl", e: "erase", l: "laser", a: "text" }[k.toLowerCase()]) inkTool({ p: "pen", h: "hl", e: "erase", l: "laser", a: "text" }[k.toLowerCase()]);
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === "v" || k === "V")) toggleVideo();
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === "t" || k === "T")) widToggle("timer");
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === "d" || k === "D")) widToggle("dice");
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === "+" || k === "=")) { e.preventDefault(); zoomStep(1); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === "-" || k === "_")) { e.preventDefault(); zoomStep(-1); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && k === "0") { e.preventDefault(); zoomTo(1); }
    else if (k === "Home") { SL.show.idx = 0; SL.show.step = 0; drawShow("none"); }
    else if (k === "End") { SL.show.idx = SL.show.slides.length - 1; SL.show.step = 0; drawShow("none"); }
    else if (k === "f" || k === "F") toggleFs();
  }
  /* ------------------------------------------------------------ the presenter control bar: drag it up or down, or flip it to the top or bottom */
  var CTL_KEY = "clear_ctl_pos", CTL_M = 12, ctlTimer = null;
  function ctlLoad() { try { var v = parseFloat(localStorage.getItem(CTL_KEY)); return isFinite(v) ? Math.max(0, Math.min(1, v)) : null; } catch (x) { return null; } }
  function ctlSave(f) { try { localStorage.setItem(CTL_KEY, String(f)); } catch (x) { /* optional */ } }
  function ctlRoom(bar) { return Math.max(1, window.innerHeight - bar.offsetHeight); }
  function ctlTop(bar, y) { bar.style.bottom = "auto"; bar.style.top = Math.max(0, Math.min(ctlRoom(bar), y)) + "px"; }
  function ctlApply() { /* puts the bar where it was left (a fraction of the free height, so it survives a resize) and refreshes the toggle */
    var bar = $("#slCtl"), sh = SL.show; if (!bar || !sh) return;
    if (sh.ctlF != null) ctlTop(bar, sh.ctlF * ctlRoom(bar)); else { bar.style.top = ""; bar.style.bottom = ""; }
    var up = bar.getBoundingClientRect().top < ctlRoom(bar) / 2, b = $("#slCtlFlip");
    if (b) { var t = up ? "Move bar to bottom" : "Move bar to top"; b.innerHTML = up ? "&#8595;" : "&#8593;"; b.title = t; b.setAttribute("aria-label", t); }
  }
  function ctlKeep() { var bar = $("#slCtl"), sh = SL.show; if (!bar || !sh) return; sh.ctlF = bar.getBoundingClientRect().top / ctlRoom(bar); ctlSave(sh.ctlF); ctlApply(); }
  function ctlFlip() {
    var bar = $("#slCtl"), sh = SL.show; if (!bar || !sh) return; var room = ctlRoom(bar);
    sh.ctlF = bar.getBoundingClientRect().top < room / 2 ? Math.max(0, room - CTL_M) / room : Math.min(1, CTL_M / room);
    ctlSave(sh.ctlF); ctlApply(); ctlWake();
  }
  function ctlWake() { /* the bar fades after 3 s without movement (mouse devices) and returns when the pointer moves */
    var bar = $("#slCtl"); if (!bar) return; bar.classList.add("awake"); clearTimeout(ctlTimer);
    ctlTimer = setTimeout(function () { var b = $("#slCtl"); if (!b) return; if (b.matches(":hover") || b.classList.contains("moving")) return ctlWake(); b.classList.remove("awake"); }, 3000);
  }
  function ctlWire(root) {
    var bar = $("#slCtl", root), g = $("#slCtlGrip", root); if (!bar || !g) return;
    root.addEventListener("pointermove", ctlWake); root.addEventListener("pointerdown", ctlWake);
    g.addEventListener("pointerdown", function (e) {
      if (e.button > 0) return; e.preventDefault();
      var dy = e.clientY - bar.getBoundingClientRect().top; bar.classList.add("moving");
      try { g.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      function mv(ev) { ctlTop(bar, ev.clientY - dy); }
      function up() { g.removeEventListener("pointermove", mv); g.removeEventListener("pointerup", up); g.removeEventListener("pointercancel", up); bar.classList.remove("moving"); ctlKeep(); ctlWake(); }
      g.addEventListener("pointermove", mv); g.addEventListener("pointerup", up); g.addEventListener("pointercancel", up);
    });
    g.addEventListener("click", function (e) { e.stopPropagation(); });
    ctlWake();
  }
  /* ------------------------------------------------------------ annotation tools while presenting */
  var INKC = ["#E63946", "#16181D", "#2B7FFF", "#1A9E5A", "#FFD84D", "#FFFFFF"], inkCur = null;
  function inkInit(el) {
    var sh = SL.show; sh.ink = {}; sh.tool = null; sh.col = INKC[0];
    var bar = '<button type="button" class="ink-hide" data-ink="hide" title="Hide the tools (Esc stops drawing)" aria-label="Hide the drawing tools">&#8249;</button><button type="button" class="btn sm sec" data-ink="pen" title="Pen (P)">Pen</button><button type="button" class="btn sm sec" data-ink="hl" title="Highlighter (H)">Marker</button>' +
      '<button type="button" class="btn sm sec" data-ink="erase" title="Eraser (E)">Eraser</button><button type="button" class="btn sm sec" data-ink="laser" title="Laser pointer (L)">Laser</button><button type="button" class="btn sm sec" data-ink="text" title="Text (A): click to type, drag to move, click text to edit">Text</button><div class="sl-ink-sz"><button type="button" class="btn sm sec" data-ink="tsm" title="Smaller text" aria-label="Smaller text">A&minus;</button><button type="button" class="btn sm sec" data-ink="tlg" title="Larger text" aria-label="Larger text">A+</button></div><div class="sl-ink-st">' + ["check", "cross"].map(function (k) { return '<button type="button" class="btn sm sec" data-ink="' + k + '" title="' + STAMP[k].label + '" aria-label="' + STAMP[k].label + '">' + stampIcon(k) + "</button>"; }).join("") + '</div><button type="button" class="btn sm sec" data-ink="timer" title="Timer (T)">Timer</button><button type="button" class="btn sm sec" data-ink="dice" title="Dice (D)">Dice</button><div class="sl-ink-sw">' +
      INKC.map(function (c, i) { return '<button type="button" class="sw' + (i === 0 ? " on" : "") + '" style="background:' + c + '" data-ink-col="' + c + '" aria-label="Ink colour ' + (i + 1) + '"></button>'; }).join("") +
      '</div><button type="button" class="btn sm sec" data-ink="undo" title="Undo (Ctrl+Z)">Undo</button><button type="button" class="btn sm sec" data-ink="clear" title="Clear this slide">Clear</button>';
    el.insertAdjacentHTML("beforeend", '<canvas id="slInk" class="sl-ink"></canvas><div id="slLaser" class="sl-laser" hidden></div><div class="sl-ink-bar" id="slInkBar" role="toolbar" aria-label="Annotation tools">' + bar + '</div><button type="button" class="sl-ink-tab" id="slInkTab" data-ink="showbar" title="Show the drawing tools" aria-label="Show the drawing tools" hidden>&#8250;</button>');
    inkBarApply();
    var cv = $("#slInk");
    cv.addEventListener("pointerdown", inkDown); cv.addEventListener("pointermove", inkMove); cv.addEventListener("pointerup", inkUp); cv.addEventListener("pointercancel", inkUp);
    cv.addEventListener("pointerleave", function () { var L = $("#slLaser"); if (L) L.hidden = true; });
    cv.addEventListener("click", function (e) { e.stopPropagation(); });
  }
  /* ------------------------------------------------------------ timer and dice, opened from the annotation tools */
  var TM = null, DC = null;
  function tmFmt(s) { s = Math.max(0, Math.floor(s)); var m = Math.floor(s / 60), r = s % 60; return m + ":" + (r < 10 ? "0" : "") + r; }
  function tmNow() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function tmRead() {
    if (TM.mode === "down") return TM.run ? Math.max(0, (TM.at - tmNow()) / 1000) : TM.left;
    return TM.run ? TM.up + (tmNow() - TM.at) / 1000 : TM.up;
  }
  function widBeep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; TM.ctx = TM.ctx || new AC(); var c = TM.ctx; if (c.resume) c.resume();
      [0, 0.4, 0.8].forEach(function (t) {
        var o = c.createOscillator(), g = c.createGain(), s = c.currentTime + t; o.type = "sine"; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.3, s + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.32);
        o.connect(g); g.connect(c.destination); o.start(s); o.stop(s + 0.35);
      });
    } catch (x) { /* sound is optional */ }
  }
  function tmDraw() {
    var box = $("#slTimer"), disp = $("#slTmTime"); if (!TM || !box || !disp) return;
    var s = tmRead();
    if (TM.mode === "down" && TM.run && s <= 0) {
      TM.run = false; TM.left = 0; TM.done = true; clearInterval(TM.iv); TM.iv = null; s = 0; box.hidden = false; widBeep();
    }
    disp.textContent = tmFmt(TM.mode === "down" ? Math.ceil(s) : s);
    box.classList.toggle("low", TM.mode === "down" && TM.run && s <= 10 && s > 0);
    box.classList.toggle("done", !!TM.done);
    box.classList.toggle("up", TM.mode === "up");
    var go = $('[data-wid="tgo"]', box); if (go) go.textContent = TM.run ? "Pause" : (TM.mode === "down" && TM.done ? "Restart" : "Start");
    var mode = $('[data-wid="tmode"]', box); if (mode) mode.textContent = TM.mode === "down" ? "Switch to stopwatch" : "Switch to countdown";
    var tb = $('#slInkBar [data-ink="timer"]'); if (tb) { tb.textContent = TM.run && box.hidden ? tmFmt(TM.mode === "down" ? Math.ceil(s) : s) : "Timer"; tb.classList.toggle("on", !box.hidden); }
    var live = $("#slTmLive"); if (live) live.textContent = TM.done ? "Time is up" : "";
  }
  function tmReset() { TM.run = false; clearInterval(TM.iv); TM.iv = null; TM.left = TM.set; TM.up = 0; TM.done = false; }
  function tmGo() {
    if (TM.run) { TM.left = tmRead(); TM.up = TM.mode === "up" ? tmRead() : TM.up; TM.run = false; clearInterval(TM.iv); TM.iv = null; }
    else {
      if (TM.mode === "down" && TM.left <= 0) TM.left = TM.set;
      TM.done = false; TM.run = true; TM.at = TM.mode === "down" ? tmNow() + TM.left * 1000 : tmNow();
      try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) { TM.ctx = TM.ctx || new AC(); if (TM.ctx.resume) TM.ctx.resume(); } } catch (x) { /* optional */ }
      TM.iv = setInterval(tmDraw, 200);
    }
    tmDraw();
  }
  function tmAdjust(d) {
    if (TM.mode !== "down") return;
    if (TM.run) TM.at = Math.max(tmNow(), TM.at + d * 1000); else TM.left = Math.max(0, TM.left + d);
    TM.done = false; tmDraw();
  }
  function pips(n) {
    var map = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[n] || [], h = "";
    for (var i = 0; i < 9; i++) h += '<i class="' + (map.indexOf(i) >= 0 ? "pip" : "") + '"></i>';
    return '<span class="sl-pips" aria-hidden="true">' + h + "</span>";
  }
  function diceDraw(rolling) {
    var row = $("#slDiceFaces"); if (!row || !DC) return;
    row.className = "sl-dice-row" + (rolling ? " rolling" : "");
    row.innerHTML = DC.vals.map(function (v) { return '<span class="sl-die' + (DC.sides === 6 ? " six" : "") + '">' + (DC.sides === 6 ? pips(v) : '<b>' + v + "</b>") + "</span>"; }).join("");
    var tot = DC.vals.reduce(function (a, b) { return a + b; }, 0), t = $("#slDiceTot");
    if (t) t.textContent = rolling ? "" : (DC.rolled ? (DC.vals.length > 1 ? "Total " + tot : "") : "Press Roll");
    var live = $("#slDiceLive"); if (live) live.textContent = rolling || !DC.rolled ? "" : "Rolled " + DC.vals.join(" and ") + (DC.vals.length > 1 ? ", total " + tot : "");
    $$("#slDice [data-wid=dn]").forEach(function (b) { var on = +b.getAttribute("data-v") === DC.n; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    $$("#slDice [data-wid=ds]").forEach(function (b) { var on = +b.getAttribute("data-v") === DC.sides; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  }
  function rnd(n) { var a = new Uint32Array(1); (window.crypto || window.msCrypto).getRandomValues(a); return a[0] % n + 1; }
  function diceRoll() {
    if (!DC || DC.busy) return; DC.busy = true; var n = 0, ms = 0;
    var iv = setInterval(function () {
      ms += 80; DC.vals = []; for (var i = 0; i < DC.n; i++) DC.vals.push(rnd(DC.sides)); diceDraw(true);
      if (ms >= 800) { clearInterval(iv); DC.busy = false; DC.rolled = true; diceDraw(false); }
    }, 80);
  }
  function dicePrep() { DC.vals = []; for (var i = 0; i < DC.n; i++) DC.vals.push(DC.sides === 6 ? (i % 6) + 1 : 1); DC.rolled = false; DC.busy = false; }
  function widInit(el) {
    TM = { mode: "down", set: 300, left: 300, up: 0, run: false, at: 0, iv: null, done: false, ctx: null };
    DC = { n: 2, sides: 6, vals: [], rolled: false, busy: false }; dicePrep();
    var pre = [30, 60, 120, 180, 300, 600].map(function (s) { return '<button type="button" class="btn sm sec" data-wid="tpre" data-v="' + s + '">' + tmFmt(s) + "</button>"; }).join("");
    el.insertAdjacentHTML("beforeend",
      '<div class="sl-wid sl-timer" id="slTimer" role="group" aria-label="Timer" hidden><div class="sl-wid-h" data-drag>Timer<button type="button" class="sl-wid-x" data-wid="close" data-v="timer" aria-label="Close the timer">&times;</button></div>' +
      '<div class="sl-tm-time" id="slTmTime">5:00</div><div class="sl-tm-pre" data-only="down">' + pre + '</div>' +
      '<div class="sl-tm-adj" data-only="down"><button type="button" class="btn sm sec" data-wid="tadj" data-v="-60">&minus;1 min</button><button type="button" class="btn sm sec" data-wid="tadj" data-v="-10">&minus;10 s</button><button type="button" class="btn sm sec" data-wid="tadj" data-v="10">+10 s</button><button type="button" class="btn sm sec" data-wid="tadj" data-v="60">+1 min</button></div>' +
      '<div class="sl-tm-act"><button type="button" class="btn" data-wid="tgo">Start</button><button type="button" class="btn sec" data-wid="treset">Reset</button></div>' +
      '<button type="button" class="sl-link" data-wid="tmode">Switch to stopwatch</button><span class="sl-sr" id="slTmLive" aria-live="assertive"></span></div>' +
      '<div class="sl-wid sl-dice" id="slDice" role="group" aria-label="Dice" hidden><div class="sl-wid-h" data-drag>Dice<button type="button" class="sl-wid-x" data-wid="close" data-v="dice" aria-label="Close the dice">&times;</button></div>' +
      '<div class="sl-dice-row" id="slDiceFaces"></div><div class="sl-dice-tot" id="slDiceTot"></div>' +
      '<div class="sl-dice-opt"><span>Dice</span>' + [1, 2, 3].map(function (n) { return '<button type="button" class="btn sm sec" data-wid="dn" data-v="' + n + '">' + n + "</button>"; }).join("") + '</div>' +
      '<div class="sl-dice-opt"><span>Sides</span>' + [6, 10, 12, 20].map(function (n) { return '<button type="button" class="btn sm sec" data-wid="ds" data-v="' + n + '">' + n + "</button>"; }).join("") + '</div>' +
      '<div class="sl-tm-act"><button type="button" class="btn" data-wid="roll">Roll</button></div><span class="sl-sr" id="slDiceLive" aria-live="polite"></span></div>');
    $$("#slTimer [data-only]").forEach(function (n) { n.hidden = false; });
    tmDraw(); diceDraw(false);
  }
  function widToggle(which) {
    var box = $(which === "timer" ? "#slTimer" : "#slDice"); if (!box) return;
    box.hidden = !box.hidden; if (!box.hidden) { box.style.zIndex = ++widZ; var go = $("[data-wid=roll], [data-wid=tgo]", box); if (go) go.focus(); }
    if (which === "timer") tmDraw(); else { var b = $('#slInkBar [data-ink="dice"]'); if (b) b.classList.toggle("on", !box.hidden); }
  }
  var widZ = 103;
  function widClick(e) {
    var b = e.target.closest("[data-wid]"); if (!b) return; var a = b.getAttribute("data-wid"), v = b.getAttribute("data-v");
    if (e.detail > 0 && b.blur) b.blur(); /* after a mouse click the arrow keys go back to the slides */
    if (a === "close") widToggle(v);
    else if (a === "tgo") tmGo();
    else if (a === "treset") { tmReset(); tmDraw(); }
    else if (a === "tpre") { TM.mode = "down"; TM.set = +v; tmReset(); tmDraw(); }
    else if (a === "tadj") tmAdjust(+v);
    else if (a === "tmode") { TM.mode = TM.mode === "down" ? "up" : "down"; tmReset(); $$("#slTimer [data-only]").forEach(function (n) { n.hidden = TM.mode === "up"; }); tmDraw(); }
    else if (a === "roll") diceRoll();
    else if (a === "dn") { DC.n = +v; dicePrep(); diceDraw(false); }
    else if (a === "ds") { DC.sides = +v; dicePrep(); diceDraw(false); }
  }
  function widStop() { if (TM) { clearInterval(TM.iv); try { if (TM.ctx && TM.ctx.close) TM.ctx.close(); } catch (x) { /* optional */ } } TM = null; DC = null; }
  document.addEventListener("pointerdown", function (e) { /* drag a widget by its title bar */
    var h = e.target.closest && e.target.closest(".sl-wid-h, .sl-mini-top"); if (!h || e.target.closest("button, input")) return;
    var w = h.parentNode, r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top, mini = w.id === "slMini"; if (!mini) w.style.zIndex = ++widZ;
    w.style.left = r.left + "px"; w.style.top = r.top + "px"; w.style.right = "auto"; w.style.bottom = "auto"; e.preventDefault();
    function mv(ev) { /* the audio box stays fully on screen; the timer and dice may be pushed mostly off */
      var mx = mini ? window.innerWidth - w.offsetWidth : window.innerWidth - 60, my = mini ? window.innerHeight - w.offsetHeight : window.innerHeight - 40;
      w.style.left = Math.max(0, Math.min(mx, ev.clientX - dx)) + "px"; w.style.top = Math.max(0, Math.min(my, ev.clientY - dy)) + "px"; }
    function up() { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); }
    document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
  });

  document.addEventListener("dblclick", function (e) { /* double-click the audio box's title bar: back to the corner */
    var h = e.target.closest && e.target.closest(".sl-mini-top"); if (!h || e.target.closest("button, input")) return;
    var w = h.parentNode; w.style.left = w.style.top = w.style.right = w.style.bottom = "";
  });
  window.addEventListener("resize", function () { /* keep a moved audio box on screen */
    var w = document.getElementById("slMini"); if (!w || !w.style.left) return;
    w.style.left = Math.max(0, Math.min(window.innerWidth - w.offsetWidth, parseFloat(w.style.left) || 0)) + "px"; w.style.top = Math.max(0, Math.min(window.innerHeight - w.offsetHeight, parseFloat(w.style.top) || 0)) + "px";
  });

  var inkHidden = false;
  try { inkHidden = localStorage.getItem("clear_ink_hidden") === "1"; } catch (x) { /* optional */ }
  function inkBarApply() {
    var b = $("#slInkBar"), t = $("#slInkTab"); if (!b || !t) return;
    b.classList.toggle("away", inkHidden); t.hidden = !inkHidden;
    try { localStorage.setItem("clear_ink_hidden", inkHidden ? "1" : "0"); } catch (x) { /* optional */ }
  }
  function inkXf() { return showXf(); }
  function inkPt(e) { var x = inkXf(), r = $("#slInk").getBoundingClientRect(); return [(e.clientX - r.left - x.ox) / x.s, (e.clientY - r.top - x.oy) / x.s]; }
  function inkSize() {
    var cv = $("#slInk"); if (!cv || !SL.show) return; var d = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(cv.clientWidth * d)); cv.height = Math.max(1, Math.round(cv.clientHeight * d)); inkRedraw();
  }
  function inkRedraw() {
    var cv = $("#slInk"); if (!cv || !SL.show) return;
    var g = cv.getContext("2d"), d = window.devicePixelRatio || 1, x = inkXf();
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(d * x.s, 0, 0, d * x.s, d * x.ox, d * x.oy); g.lineCap = "round"; g.lineJoin = "round";
    (SL.show.ink[SL.show.idx] || []).forEach(function (s) {
      if (s.st) { inkStamp(g, s); return; }
      if (s.tx != null) { inkText(g, s); return; }
      g.globalAlpha = s.hl ? 0.38 : 1; g.strokeStyle = s.c; g.lineWidth = s.w; g.beginPath();
      s.p.forEach(function (q, i) { if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
      if (s.p.length === 1) g.lineTo(s.p[0][0] + 0.01, s.p[0][1]);
      g.stroke();
    });
    g.globalAlpha = 1;
  }
  function inkStamp(g, s) { /* a check or cross, centred on (x, y), 0.4 in wide; strokes with round ends, so it looks the same on every device */
    var k = STAMP[s.st]; if (!k) return;
    g.save(); g.globalAlpha = 1; g.translate(s.x - STAMP_SIZE / 2, s.y - STAMP_SIZE / 2);
    g.strokeStyle = s.c || stampColor(s.st); g.lineWidth = STAMP_LW; g.lineCap = "round"; g.lineJoin = "round"; g.stroke(new Path2D(k.d)); g.restore();
  }
  function inkTool(t) {
    var sh = SL.show; if (!sh) return; inkTxCommit(); sh.tool = sh.tool === t ? null : t; inkCur = null;
    var cv = $("#slInk"); cv.className = "sl-ink" + (sh.tool ? " on tool-" + sh.tool : "");
    var L = $("#slLaser"); if (L) L.hidden = true;
    $$("#slInkBar [data-ink]").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-ink") === sh.tool); });
  }
  function inkColor(c) {
    var sh = SL.show; if (!sh) return; sh.col = c;
    $$("#slInkBar [data-ink-col]").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-ink-col") === c); });
    if (sh.tool === "text") { if (txEd) { txEd.c = c; inkTxStyle(); txEd.ta.focus(); } return; }
    if (sh.tool !== "pen" && sh.tool !== "hl") inkTool("pen");
  }
  function inkDown(e) {
    var sh = SL.show; if (!sh || !sh.tool) return; e.preventDefault(); e.stopPropagation();
    if (this.setPointerCapture) { try { this.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } }
    if (sh.tool === "laser") { inkLaser(e); return; }
    var p = inkPt(e);
    if (sh.tool === "text") { inkTxDown(p); return; }
    if (sh.tool === "erase") { inkCur = "erase"; inkErase(p); return; }
    if (STAMP[sh.tool]) { /* press to place; slide the finger or mouse before letting go to fine-tune the spot */
      var sl = sh.ink[sh.idx] || (sh.ink[sh.idx] = []); inkCur = { st: sh.tool, c: stampColor(sh.tool), x: 0, y: 0 }; inkSpot(inkCur, p); sl.push(inkCur); inkRedraw(); return;
    }
    var list = sh.ink[sh.idx] || (sh.ink[sh.idx] = []);
    inkCur = { c: sh.col, w: sh.tool === "hl" ? 26 : 5, hl: sh.tool === "hl", p: [p] }; list.push(inkCur); inkRedraw();
  }
  function inkMove(e) {
    var sh = SL.show; if (!sh || !sh.tool) return;
    if (sh.tool === "laser") { inkLaser(e); return; }
    if (!inkCur) return; var p = inkPt(e);
    if (inkCur.mv) { inkTxDrag(p); return; }
    if (inkCur === "erase") inkErase(p); else if (inkCur.st) { inkSpot(inkCur, p); inkRedraw(); } else { inkCur.p.push(p); inkRedraw(); }
  }
  function inkUp() {
    var c = inkCur; inkCur = null;
    if (c && c.mv) { if (!c.moved) inkTxOpen(c.mv, null); else if (txEd) txEd.ta.focus(); return; }
    if (txEd && SL.show && SL.show.tool === "text") { var t = txEd.ta; setTimeout(function () { try { t.focus(); } catch (x) { /* ignore */ } }, 0); }
  }
  function inkSpot(st, p) { st.x = Math.max(0, Math.min(W * PX, p[0])); st.y = Math.max(0, Math.min(H * PX, p[1])); }
  function inkErase(p) {
    var sh = SL.show, l = sh.ink[sh.idx]; if (!l || !l.length) return; var r = 16 / inkXf().s;
    var keep = l.filter(function (s) { if (s.tx != null) return !(p[0] >= s.x - r && p[0] <= s.x + s.w + r && p[1] >= s.y - r && p[1] <= s.y + s.h + r); if (s.st) return Math.hypot(s.x - p[0], s.y - p[1]) >= r + STAMP_SIZE / 2; return !s.p.some(function (q) { return Math.hypot(q[0] - p[0], q[1] - p[1]) < r + s.w / 2; }); });
    if (keep.length !== l.length) { sh.ink[sh.idx] = keep; inkRedraw(); }
  }
  function inkLaser(e) { var L = $("#slLaser"); if (!L) return; L.hidden = false; L.style.left = e.clientX + "px"; L.style.top = e.clientY + "px"; }
  function inkUndo() { var sh = SL.show; if (!sh) return; if (txEd) { inkTxCancel(); return; } var l = sh.ink[sh.idx]; if (l && l.length) { l.pop(); inkRedraw(); } }
  function inkClear() { var sh = SL.show; if (!sh) return; inkTxCancel(); sh.ink[sh.idx] = []; inkRedraw(); }

  /* ---- text labels: click to type, drag to move, click a label to edit it. Kept like strokes: per slide, drawn on the same canvas, so they zoom with the slide ---- */
  var TXS = [28, 36, 48, 64, 88, 120], TX_LH = 1.25, TX_FONT = "system-ui, 'Segoe UI', Roboto, Arial, sans-serif", txEd = null, txMc = null;
  function txFont(fs) { return "600 " + fs + "px " + TX_FONT; }
  function txMeasure(s) { /* width and height of a label in slide pixels */
    if (!txMc) txMc = document.createElement("canvas").getContext("2d");
    txMc.font = txFont(s.fs); var lines = String(s.tx).split("\n"), w = 0;
    lines.forEach(function (t) { w = Math.max(w, txMc.measureText(t).width); }); s.w = w; s.h = lines.length * s.fs * TX_LH; return s;
  }
  function txHalo(c) { /* a thin outline in the opposite tone, so white or yellow text still reads on a light slide and dark text on a dark one */
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || ""); if (!m) return "rgba(255,255,255,.85)";
    var l = (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) / 255; return l > 0.6 ? "rgba(22,24,29,.85)" : "rgba(255,255,255,.9)";
  }
  function inkText(g, s) {
    g.save(); g.globalAlpha = 1; g.font = txFont(s.fs); g.textBaseline = "middle"; g.textAlign = "left"; g.lineJoin = "round"; g.lineWidth = s.fs * 0.14; g.strokeStyle = txHalo(s.c); g.fillStyle = s.c;
    String(s.tx).split("\n").forEach(function (t, i) { var y = s.y + (i + 0.5) * s.fs * TX_LH; g.strokeText(t, s.x, y); g.fillText(t, s.x, y); });
    g.restore();
  }
  function inkTxHit(p) { /* the newest label under the point, or null */
    var sh = SL.show, l = (sh && sh.ink[sh.idx]) || [], pad = 8 / inkXf().s;
    for (var i = l.length - 1; i >= 0; i--) { var s = l[i]; if (s.tx != null && p[0] >= s.x - pad && p[0] <= s.x + s.w + pad && p[1] >= s.y - pad && p[1] <= s.y + s.h + pad) return s; }
    return null;
  }
  function inkTxDown(p) {
    var sh = SL.show; inkTxCommit();
    var hit = inkTxHit(p); if (hit) { inkCur = { mv: hit, dx: p[0] - hit.x, dy: p[1] - hit.y, moved: false, sx: p[0], sy: p[1] }; return; }
    inkTxOpen({ tx: "", x: Math.max(0, Math.min(W * PX - 40, p[0])), y: Math.max(0, Math.min(H * PX - TXS[sh.fsi == null ? 2 : sh.fsi] * TX_LH, p[1] - TXS[sh.fsi == null ? 2 : sh.fsi] * TX_LH / 2)), c: sh.col, fs: TXS[sh.fsi == null ? 2 : sh.fsi] }, null);
  }
  function inkTxDrag(p) {
    var c = inkCur, s = c.mv; if (!c.moved && Math.hypot(p[0] - c.sx, p[1] - c.sy) * inkXf().s < 5) return; c.moved = true;
    s.x = Math.max(0, Math.min(W * PX - Math.min(s.w, W * PX), p[0] - c.dx)); s.y = Math.max(0, Math.min(H * PX - s.h, p[1] - c.dy)); inkRedraw();
  }
  function inkTxOpen(s, _) { /* s is a new label (tx "") or an existing one being edited; it leaves the list while the box is open and goes back on commit */
    var sh = SL.show, root = $("#slShow"); if (!sh || !root) return; inkTxCommit();
    var list = sh.ink[sh.idx] || (sh.ink[sh.idx] = []), at = list.indexOf(s); if (at >= 0) list.splice(at, 1);
    var ta = document.createElement("textarea"); ta.className = "sl-tx"; ta.value = s.tx; ta.rows = 1; ta.wrap = "off"; ta.spellcheck = false; ta.setAttribute("aria-label", "Text on the slide"); ta.setAttribute("autocomplete", "off");
    ["pointerdown", "pointerup", "click", "dblclick", "wheel"].forEach(function (n) { ta.addEventListener(n, function (e) { e.stopPropagation(); }); });
    ta.addEventListener("input", function () { inkTxStyle(); });
    ta.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); inkTxCommit(); }
      else if (e.key === "Escape") { e.preventDefault(); inkTxCommit(); }
    });
    root.appendChild(ta); txEd = { ta: ta, x: s.x, y: s.y, c: s.c, fs: s.fs, idx: sh.idx }; inkRedraw(); inkTxStyle(); ta.focus();
    if (s.tx) { try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (x) { /* ignore */ } }
  }
  function inkTxStyle() { /* size, colour and place of the live box; it matches what will be drawn */
    if (!txEd) return; var ta = txEd.ta, x = inkXf(), cv = $("#slInk"); if (!cv) return; var r = cv.getBoundingClientRect(), s = x.s, fs = txEd.fs;
    var lines = ta.value.split("\n"); if (!txMc) txMc = document.createElement("canvas").getContext("2d"); txMc.font = txFont(fs);
    var w = 0; lines.forEach(function (t) { w = Math.max(w, txMc.measureText(t).width); });
    ta.style.left = (r.left + x.ox + txEd.x * s) + "px"; ta.style.top = (r.top + x.oy + txEd.y * s) + "px";
    ta.style.fontSize = (fs * s) + "px"; ta.style.lineHeight = String(TX_LH); ta.style.color = txEd.c;
    ta.style.width = (Math.max(fs * 2.5, w + fs * 0.6) * s) + "px"; ta.style.height = (lines.length * fs * TX_LH * s) + "px";
    var hl = txHalo(txEd.c), b = Math.max(1, fs * s * 0.06); ta.style.textShadow = "0 0 " + b + "px " + hl + ",0 0 " + b + "px " + hl + ",0 0 " + b + "px " + hl;
  }
  function inkTxPlace() { if (txEd) inkTxStyle(); }
  function inkTxSize(d) {
    var sh = SL.show; if (!sh) return; var i = Math.max(0, Math.min(TXS.length - 1, (sh.fsi == null ? 2 : sh.fsi) + d));
    sh.fsi = i; if (txEd) { txEd.fs = TXS[i]; inkTxStyle(); txEd.ta.focus(); } else if (sh.tool !== "text") inkTool("text");
    var m = $('#slInkBar [data-ink="tsm"]'), g = $('#slInkBar [data-ink="tlg"]'); if (m) m.disabled = i <= 0; if (g) g.disabled = i >= TXS.length - 1;
  }
  function inkTxClose() { var e = txEd; txEd = null; if (e && e.ta.parentNode) e.ta.parentNode.removeChild(e.ta); return e; }
  function inkTxCommit() { /* keeps what was typed; an empty box leaves nothing behind */
    if (!txEd) return; var e = inkTxClose(), sh = SL.show, v = e.ta.value.replace(/\s+$/, "");
    if (sh && v) { var l = sh.ink[e.idx] || (sh.ink[e.idx] = []); l.push(txMeasure({ tx: v, x: e.x, y: e.y, c: e.c, fs: e.fs })); }
    inkRedraw();
  }
  function inkTxCancel() { /* drops what was typed in the open box; a label that was being edited is gone with it */
    if (!txEd) return; inkTxClose(); inkRedraw();
  }
  function toggleFs() { var el = $("#slShow"); if (!el) return; if (document.fullscreenElement) document.exitFullscreen(); else enterFs(el); }
  function onShowClick(e) {
    if (e.target.closest("[data-aud]") || e.target.closest(".sl-tx")) return;
    var vb = e.target.closest("[data-vid]"); if (vb) { toggleVideo(vb.getAttribute("data-vid")); return; }
    if (e.target.closest(".sl-video")) return; /* the video's own controls handle the click; it never advances the slide */
    if (e.target.closest(".sl-wid")) { widClick(e); return; }
    var ik = e.target.closest("[data-ink]"), ic = e.target.closest("[data-ink-col]");
    if (ik) { var ia = ik.getAttribute("data-ink"); if (ia === "hide" || ia === "showbar") { inkHidden = ia === "hide"; inkBarApply(); return; } if (ia === "timer" || ia === "dice") { widToggle(ia); return; } if (ia === "undo") inkUndo(); else if (ia === "clear") inkClear(); else if (ia === "tsm" || ia === "tlg") inkTxSize(ia === "tlg" ? 1 : -1); else inkTool(ia); return; }
    if (ic) { inkColor(ic.getAttribute("data-ink-col")); return; }
    if (e.target.closest(".sl-ink-bar") || e.target.closest(".sl-ink-tab")) return;
    var b = e.target.closest("[data-sh]");
    if (b) { var a = b.getAttribute("data-sh"); if (a === "next") showNext(); else if (a === "prev") showPrev(); else if (a === "exit") exitShow(); else if (a === "full") toggleFs(); else if (a === "flip") ctlFlip(); else if (a === "zin") zoomStep(1); else if (a === "zout") zoomStep(-1); else if (a === "zreset") zoomTo(1); return; }
    if (e.target.closest(".sl-ctl")) return;
    if (SL.show && SL.show.noClick && Date.now() - SL.show.noClick < 400) { SL.show.noClick = 0; return; } /* the click that ends a drag of the zoomed slide */
    if (trigClick(e, $("#slSbox"))) return; /* a trigger item reveals its items and never advances the slide */
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
  function studentCards(sid) {
    load();
    var list = SL.decks;
    if (sid) { /* teacher preview: only what this student could see */
      var mine = {}; (A().lessonsList() || []).forEach(function (l) { if (l.student_id === sid && l.cur_lesson_id) mine[l.cur_lesson_id] = 1; });
      list = list.filter(function (d) { return d.visible_to_students && mine[d.cur_lesson_id]; });
    }
    if (!list.length) return "";
    return '<div class="sec"><h3>Your slides</h3><p class="hint">Open the slides on any device and use Slide show to present. Click or press the right arrow to move on.</p><div class="cards">' + list.map(function (d) { return deckCard(d, false); }).join("") + "</div></div>";
  }
  function click(a, id) {
    if (a === "sl_pptx") {
      var ex = SL.decks.filter(function (x) { return x.source_file_id === id; })[0];
      if (ex) { open(ex.id, "view"); return true; }
      A().sb.from("cur_files").select("*").eq("id", id).maybeSingle().then(function (r) {
        if (!r.data) { toast("Could not read that file.", true); return; }
        fileToDeck(r.data).then(function (d) { if (d) open(d.id, "view"); });
      }); return true;
    }
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
      A().sb.from("decks").insert({ cur_lesson_id: id, title: title, slides: [s] }).select("id,cur_lesson_id,title,visible_to_students,updated_at,source_file_id").single().then(function (r) {
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

  /* ------------------------------------------------------------ any .pptx file becomes slides */
  function isPptx(f) { return f && (/\.pptx$/i.test(f.file_name || "") || (f.kind === "slides" && /\.pdf$/i.test(f.file_name || ""))); }
  function isPdf(f) { return /\.pdf$/i.test(f.file_name || "") && !/\.pptx$/i.test(f.file_name || ""); }
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise(function (res, rej) {
      var sc = document.createElement("script"); sc.src = "vendor/pdf.min.js";
      sc.onload = function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"; res(window.pdfjsLib); };
      sc.onerror = function () { rej(new Error("PDF reader did not load")); }; document.head.appendChild(sc);
    });
  }
  /* a PDF of slides becomes one full-slide picture per page (view, present, add audio and text on top) */
  function pdfToDeck(buf) {
    return loadPdfJs().then(function (lib) { return lib.getDocument({ data: buf }).promise; }).then(function (pdf) {
      var slides = [], assets = {}, p = Promise.resolve();
      for (var n = 1; n <= pdf.numPages; n++) (function (n) {
        p = p.then(function () { return pdf.getPage(n); }).then(function (page) {
          var v1 = page.getViewport({ scale: 1 }), sc = 1100 / v1.width, vp = page.getViewport({ scale: sc }), cv = document.createElement("canvas");
          cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
          return page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise.then(function () {
            var id = "a" + n, h = Math.min(7.5, 13.333 * cv.height / cv.width), w = h * cv.width / cv.height;
            assets[id] = { kind: "image", name: "page-" + n + ".jpg", mime: "image/jpeg", data: cv.toDataURL("image/jpeg", 0.74).split(",")[1] };
            slides.push({ id: "s" + n, bg: "#FFFFFF", tr: "fade", items: [{ id: "p" + n, t: "img", x: Math.round((13.333 - w) / 2 * 1000) / 1000, y: Math.round((7.5 - h) / 2 * 1000) / 1000, w: Math.round(w * 1000) / 1000, h: Math.round(h * 1000) / 1000, step: 0, src: id }] });
          });
        });
      })(n);
      return p.then(function () { return { slides: slides, notes: {}, assets: assets, skipped: 0 }; });
    });
  }
  /* assets of a new deck: pictures stay inside the table row (as always); video and audio are uploaded to the private 'materials' bucket and the row keeps only the path.
     a.blob (browser import) or a.data (base64, from an import bundle) holds the bytes. Fills map (temporary id -> real id) and resolves to the rows to insert. */
  function prepAssets(deckId, assets, map) {
    var rows = [], sb = A().sb, p = Promise.resolve();
    Object.keys(assets).forEach(function (k) {
      var a = assets[k]; map[k] = uid();
      if (a.kind === "video" || a.kind === "audio") {
        p = p.then(function () {
          return Promise.resolve(a.blob ? a.blob : a.fetchBlob ? a.fetchBlob() : a.data ? new Blob([b64buf(a.data)], { type: a.mime }) : null).then(function (blob) {
            if (!blob) throw new Error("A " + a.kind + " file is missing from the import.");
            var ext = ((a.name || "").split(".").pop() || (a.kind === "video" ? "mp4" : "mp3")).toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4", path = "decks/" + deckId + "/" + uid() + "." + ext;
            return sb.storage.from("materials").upload(path, blob, { contentType: a.mime, upsert: false }).then(function (r) {
              if (r.error) throw new Error(r.error.message + (a.kind === "video" ? " (videos can be up to 50 MB)" : ""));
              rows.push({ id: map[k], deck_id: deckId, kind: a.kind, name: a.name, mime: a.mime, file_path: path });
            });
          });
        });
      } else rows.push({ id: map[k], deck_id: deckId, kind: a.kind, name: a.name, mime: a.mime, data: a.data });
    });
    return p.then(function () { return rows; });
  }
  function pptxBtn(f) {
    if (!isPptx(f)) return "";
    var d = SL.decks.filter(function (x) { return x.source_file_id === f.id; })[0];
    return '<button type="button" class="btn sm" data-act="sl_pptx" data-id="' + f.id + '">' + (d ? "Slides: view or edit" : "Open as slides") + "</button>";
  }
  var busy = {}, tried = {}, sweepFiles = [], sweeping = false;
  function fileToDeck(f) {
    var sb = A().sb;
    if (busy[f.id]) return Promise.resolve(null);
    if (!window.CLEAR_PPTX || !window.JSZip) { toast("The PowerPoint reader did not load. Refresh the page.", true); return Promise.resolve(null); }
    busy[f.id] = 1; toast("Turning " + (f.title || f.file_name) + " into slides. This takes a few seconds…");
    return sb.storage.from("materials").createSignedUrl(f.file_path, 600).then(function (r) {
      if (r.error || !r.data) throw new Error((r.error && r.error.message) || "File not available.");
      return fetch(r.data.signedUrl);
    }).then(function (r) { if (!r.ok) throw new Error("Could not download the file."); return r.arrayBuffer(); })
      .then(function (buf) { return isPdf(f) ? pdfToDeck(buf) : window.CLEAR_PPTX.convert(buf); }).then(function (res) {
        if (!res.slides.length) throw new Error("No slides found in that file.");
        var deckId = uid(), map = {};
        return prepAssets(deckId, res.assets, map).then(function (rows) {
        res.slides.forEach(function (sl) { sl.items.forEach(function (i) { if ((i.t === "img" || i.t === "video") && i.src) i.src = map[i.src]; }); });
        return sb.from("decks").insert({ id: deckId, cur_lesson_id: f.lesson_id, title: f.title || f.file_name.replace(/\.(pptx|pdf)$/i, ""), slides: res.slides, visible_to_students: !!f.for_student, source_file_id: f.id })
          .select("id,cur_lesson_id,title,visible_to_students,updated_at,source_file_id").single().then(function (ins) {
            if (ins.error) { if (String(ins.error.code) === "23505") { load(true); return null; } throw new Error(ins.error.message); }
            var p = Promise.resolve();
            for (var i = 0; i < rows.length; i += 4) (function (part) { p = p.then(function () { return sb.from("deck_assets").insert(part).then(function (r2) { if (r2.error) throw new Error(r2.error.message); }); }); })(rows.slice(i, i + 4));
            return p.then(function () { return sb.from("deck_notes").upsert({ deck_id: deckId, notes: res.notes || {} }); }).then(function () {
              SL.decks.push(ins.data);
              toast("Slides ready: " + ins.data.title + (res.skipped ? " (" + res.skipped + " items such as tables, charts or unsupported videos could not be converted)" : ""));
              return ins.data;
            });
          });
        });
      }).catch(function (e) { tried[f.id] = 1; toast("Could not convert to slides: " + (e.message || e), true); return null; })
      .then(function (d) { delete busy[f.id]; return d; });
  }
  function doSweep() {
    if (sweeping || !isAdmin() || !SL.loaded) return;
    sweeping = true;
    A().sb.from("cur_files").select("*").or("file_name.ilike.%.pptx,and(kind.eq.slides,file_name.ilike.%.pdf)").then(function (r) {
      var files = (r && r.data) || [];
      var todo = files.filter(function (f) { return isPptx(f) && !tried[f.id] && !SL.decks.some(function (d) { return d.source_file_id === f.id; }); });
      if (!todo.length) { sweeping = false; return; }
      return todo.reduce(function (p, f) { return p.then(function () { tried[f.id] = 1; return fileToDeck(f); }); }, Promise.resolve()).then(function () { sweeping = false; if (A().render) A().render(); });
    }).catch(function (e) { sweeping = false; toast("Slide conversion check failed: " + (e.message || e), true); });
  }
  function sweep(files) { sweepFiles = files || []; doSweep(); }

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
    /* an encrypted file shipped with the app: first 12 bytes are the IV. Big binaries (video, large files) are separate .enc files named in the bundle ("ext"), same key. */
    function openEnc(file) {
      return fetch(file, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("Import file not found (" + file + ")"); return r.arrayBuffer(); }).then(function (buf) {
        var u = new Uint8Array(buf), iv = u.slice(0, 12), ct = u.slice(12);
        return crypto.subtle.importKey("raw", hex2buf(job.key), "AES-GCM", false, ["decrypt"]).then(function (k) { return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, k, ct); });
      });
    }
    function openExt(file, mime) { return openEnc(file).then(function (pt) { return new Blob([pt], { type: mime }); }); }
    return openEnc(job.file).then(function (pt) {
      var B = JSON.parse(new TextDecoder().decode(pt)), parts = B.lesson_ref.split(":");
      return sb.from("cur_levels").select("id").eq("code", parts[0]).maybeSingle().then(function (lv) {
        return sb.from("cur_lessons").select("id").eq("level_id", lv.data.id).eq("number", Number(parts[1])).maybeSingle();
      }).then(function (ls) {
        var lid = ls.data.id, chain = Promise.resolve();
        if (B.deck) {
          chain = chain.then(function () { return sb.from("decks").select("id").eq("cur_lesson_id", lid).eq("title", B.deck.title).maybeSingle(); }).then(function (ex) {
            if (ex.data) return;
            var deckId = uid(), map = {};
            Object.keys(B.assets || {}).forEach(function (k) { var a = B.assets[k]; if (a.ext) a.fetchBlob = function () { return openExt(a.ext, a.mime); }; });
            return prepAssets(deckId, B.assets || {}, map).then(function (rows) {
              B.deck.slides.forEach(function (s) { s.items.forEach(function (i) { if ((i.t === "img" || i.t === "video") && i.src) i.src = map[i.src]; }); });
              return sb.from("decks").insert({ id: deckId, cur_lesson_id: lid, title: B.deck.title, slides: B.deck.slides, visible_to_students: false }).then(function (r1) {
                if (r1.error) throw new Error(r1.error.message);
                var p = Promise.resolve();
                for (var i = 0; i < rows.length; i += 4) (function (part) { p = p.then(function () { return sb.from("deck_assets").insert(part).then(function (r2) { if (r2.error) throw new Error(r2.error.message); }); }); })(rows.slice(i, i + 4));
                return p.then(function () { return sb.from("deck_notes").upsert({ deck_id: deckId, notes: B.notes || {} }); });
              });
            });
          });
        }
        (B.files || []).forEach(function (f) {
          chain = chain.then(function () { return sb.from("cur_files").select("id").eq("lesson_id", lid).eq("file_name", f.file_name).maybeSingle(); }).then(function (ex) {
            if (ex.data) return;
            var path = "kits/" + lid + "/" + uid() + "-" + f.file_name.replace(/[^\w.\-]+/g, "-");
            return (f.ext ? openExt(f.ext, f.mime) : Promise.resolve(new Blob([b64buf(f.b64)], { type: f.mime }))).then(function (blob) {
              return bucket.upload(path, blob, { contentType: f.mime, upsert: false }).then(function (up) {
                if (up.error) throw new Error(up.error.message);
                return sb.from("cur_files").insert({ lesson_id: lid, kind: f.kind, title: f.title, for_student: f.for_student, file_path: path, file_name: f.file_name, mime: f.mime, size_bytes: blob.size });
              });
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

  window.CLEAR_SL = { click: click, panel: panel, teacherPanel: teacherPanel, studentCards: studentCards, load: load, reset: function () { SL.loaded = false; SL.loading = false; SL.decks = []; tried = {}; }, runImports: runImports, pptxBtn: pptxBtn, sweep: sweep };
})();
