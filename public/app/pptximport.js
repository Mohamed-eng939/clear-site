/* CLEAR: reads a .pptx in the browser and turns it into the slide-deck JSON used by slides.js.
   window.CLEAR_PPTX.convert(arrayBuffer) -> Promise({ slides, notes, assets, skipped }) */
(function () {
  "use strict";
  var NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  var NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
  var NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  var W = 13.333, H = 7.5, MAXW = 1100;

  function kids(el, ns, name) { var out = []; if (!el) return out; for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name && (!ns || c.namespaceURI === ns)) out.push(c); return out; }
  function kid(el, ns, name) { return kids(el, ns, name)[0] || null; }
  function path(el, steps) { var cur = el; for (var i = 0; i < steps.length && cur; i++) { var s = steps[i].split(":"); cur = kid(cur, s[0] === "a" ? NS_A : NS_P, s[1]); } return cur; }
  function all(el, ns, name) { return Array.prototype.slice.call(el.getElementsByTagNameNS(ns, name)); }
  function parse(txt) { return new DOMParser().parseFromString(txt, "application/xml"); }
  function inch(v) { return Math.round(Number(v) / 914400 * 1000) / 1000; }
  function dirOf(p) { var i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
  function resolve(base, target) {
    if (target.charAt(0) === "/") return target.slice(1);
    var parts = dirOf(base).split("/").filter(Boolean);
    target.split("/").forEach(function (seg) { if (seg === "..") parts.pop(); else if (seg !== "." && seg) parts.push(seg); });
    return parts.join("/");
  }

  function convert(buf) {
    var zip, theme = {}, sldW = 12192000, sldH = 6858000, assets = {}, imgCache = {}, skipped = 0;
    var textCache = {};
    function text(p) { if (p in textCache) return textCache[p]; var f = zip.file(p); return textCache[p] = f ? f.async("string") : Promise.resolve(null); }
    function xml(p) { return text(p).then(function (t) { return t ? parse(t) : null; }); }
    function relsOf(part) { var d = dirOf(part), n = part.slice(part.lastIndexOf("/") + 1); return xml((d ? d + "/" : "") + "_rels/" + n + ".rels").then(function (doc) { var m = {}; if (doc) all(doc, "http://schemas.openxmlformats.org/package/2006/relationships", "Relationship").forEach(function (r) { m[r.getAttribute("Id")] = { type: r.getAttribute("Type"), target: resolve(part, r.getAttribute("Target")), ext: r.getAttribute("TargetMode") === "External" }; }); return m; }); }

    function colorOf(holder) {
      if (!holder) return null;
      var s = kid(holder, NS_A, "solidFill"); if (!s) return null;
      var c = kid(s, NS_A, "srgbClr"); if (c) return "#" + c.getAttribute("val");
      c = kid(s, NS_A, "schemeClr");
      if (c) { var v = c.getAttribute("val"), map = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" }; v = map[v] || v; var hex = theme[v]; if (hex) return "#" + hex; return v === "lt1" ? "#FFFFFF" : null; }
      c = kid(s, NS_A, "sysClr"); if (c) return "#" + (c.getAttribute("lastClr") || "000000");
      return null;
    }

    function addImage(rid, rels, name) {
      var rel = rels[rid]; if (!rel || rel.ext) return Promise.resolve(null);
      if (imgCache[rel.target]) return imgCache[rel.target];
      var f = zip.file(rel.target); if (!f) return Promise.resolve(null);
      var ext = rel.target.split(".").pop().toLowerCase();
      if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].indexOf(ext) < 0) return imgCache[rel.target] = Promise.resolve(null);
      return imgCache[rel.target] = f.async("blob").then(function (blob) {
        var typed = new Blob([blob], { type: ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : ext === "bmp" ? "image/bmp" : "image/jpeg" });
        return (window.createImageBitmap ? createImageBitmap(typed) : Promise.reject(new Error("no bitmap"))).then(function (bm) {
          var w = bm.width, h = bm.height, sc = w > MAXW ? MAXW / w : 1, cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(w * sc)); cv.height = Math.max(1, Math.round(h * sc));
          var cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(bm, 0, 0, cv.width, cv.height);
          var data = cv.toDataURL("image/jpeg", 0.82).split(",")[1];
          var id = "a" + Object.keys(assets).length;
          assets[id] = { kind: "image", name: name || rel.target.split("/").pop(), mime: "image/jpeg", data: data };
          return id;
        });
      }).catch(function () { return null; });
    }

    function findLayoutXfrm(ph, chain) {
      for (var i = 0; i < chain.length; i++) {
        var doc = chain[i]; if (!doc) continue;
        var sps = all(doc, NS_P, "sp");
        for (var j = 0; j < sps.length; j++) {
          var ph2 = path(sps[j], ["p:nvSpPr", "p:nvPr", "p:ph"]); if (!ph2) continue;
          var sameIdx = ph.getAttribute("idx") != null && ph.getAttribute("idx") === ph2.getAttribute("idx");
          var sameType = ph.getAttribute("type") && ph.getAttribute("type") === ph2.getAttribute("type");
          if (sameIdx || (ph.getAttribute("idx") == null && sameType)) { var x = path(sps[j], ["p:spPr", "a:xfrm"]); if (x) return x; }
        }
      }
      return null;
    }

    function xfrmBox(x, tx) {
      var off = kid(x, NS_A, "off"), ext = kid(x, NS_A, "ext"); if (!off || !ext) return null;
      var ox = Number(off.getAttribute("x")), oy = Number(off.getAttribute("y")), cx = Number(ext.getAttribute("cx")), cy = Number(ext.getAttribute("cy"));
      return { x: tx.ox + (ox - tx.cox) * tx.sx, y: tx.oy + (oy - tx.coy) * tx.sy, w: cx * tx.sx, h: cy * tx.sy };
    }

    function shapeItems(tree, ctx, tx, steps, out) {
      var chain = Promise.resolve();
      kids(tree, null, null).length; // keep minimal
      for (var el = tree.firstElementChild; el; el = el.nextElementSibling) (function (el) {
        var ln = el.localName;
        if (ln === "grpSp") {
          chain = chain.then(function () {
            var gx = path(el, ["p:grpSpPr", "a:xfrm"]); if (!gx) return;
            var off = kid(gx, NS_A, "off"), ext = kid(gx, NS_A, "ext"), co = kid(gx, NS_A, "chOff"), ce = kid(gx, NS_A, "chExt"); if (!off || !ext || !co || !ce) return;
            var cext = { x: Number(ce.getAttribute("cx")) || 1, y: Number(ce.getAttribute("cy")) || 1 };
            var t2 = { ox: tx.ox + (Number(off.getAttribute("x")) - tx.cox) * tx.sx, oy: tx.oy + (Number(off.getAttribute("y")) - tx.coy) * tx.sy,
              cox: Number(co.getAttribute("x")), coy: Number(co.getAttribute("y")),
              sx: tx.sx * Number(ext.getAttribute("cx")) / cext.x, sy: tx.sy * Number(ext.getAttribute("cy")) / cext.y };
            return shapeItems(el, ctx, t2, steps, out);
          });
          return;
        }
        if (ln === "graphicFrame") { skipped++; return; }
        if (ln !== "sp" && ln !== "pic" && ln !== "cxnSp") return;
        chain = chain.then(function () {
          var cNv = path(el, [ln === "pic" ? "p:nvPicPr" : ln === "cxnSp" ? "p:nvCxnSpPr" : "p:nvSpPr", "p:cNvPr"]);
          var sid = cNv ? Number(cNv.getAttribute("id")) : Math.floor(Math.random() * 1e6), nm = cNv ? cNv.getAttribute("name") : "";
          var spPr = kid(el, NS_P, "spPr"), x = spPr && kid(spPr, NS_A, "xfrm");
          if (!x && ln === "sp") { var ph = path(el, ["p:nvSpPr", "p:nvPr", "p:ph"]); if (ph) x = findLayoutXfrm(ph, ctx.chain); }
          var box = x && xfrmBox(x, tx); if (!box) return;
          var it = { id: "i" + sid + (out.length > 400 ? "x" : ""), x: inch(box.x * 1), y: inch(box.y * 1), w: inch(box.w * 1), h: inch(box.h * 1), step: steps[sid] || 0 };
          if (it.step) it.fx = "fade";
          if (ln === "cxnSp") { var lc = colorOf(kid(spPr, NS_A, "ln")); if (!lc) return; it.t = "box"; it.shape = "rect"; it.fill = lc; it.paras = [{ al: "l", runs: [{ t: "" }] }]; if (it.w > it.h) it.h = Math.max(it.h, 0.02); else it.w = Math.max(it.w, 0.02); out.push(it); return; }
          if (ln === "pic") {
            var blip = path(el, ["p:blipFill", "a:blip"]); if (!blip) return;
            return addImage(blip.getAttributeNS(NS_R, "embed"), ctx.rels, nm).then(function (aid) { if (!aid) { skipped++; return; } it.t = "img"; it.src = aid; out.push(it); });
          }
          // sp
          var geom = kid(spPr, NS_A, "prstGeom"), prst = geom ? geom.getAttribute("prst") : "rect";
          it.shape = prst === "roundRect" ? "round" : prst === "ellipse" ? "oval" : "rect";
          if (prst === "roundRect") { var gd = geom && kid(kid(geom, NS_A, "avLst"), NS_A, "gd"); it.rad = gd ? Math.round(Number(gd.getAttribute("fmla").split(" ")[1]) / 100000 * 1000) / 1000 : 0.16667; }
          it.fill = colorOf(spPr);
          var line = kid(spPr, NS_A, "ln");
          if (line && colorOf(line)) { it.line = colorOf(line); it.lw = Math.round(Number(line.getAttribute("w") || 12700) / 12700 * 100) / 100; if (kid(line, NS_A, "prstDash")) it.dash = true; }
          // picture fill (e.g. shape filled with an image)
          var bf = kid(spPr, NS_A, "blipFill");
          var tb = kid(el, NS_P, "txBody"), bp = tb && kid(tb, NS_A, "bodyPr");
          it.anchor = ({ t: "t", ctr: "m", b: "b" })[bp ? (bp.getAttribute("anchor") || "t") : "t"] || "t";
          it.ins = bp ? [["lIns", 91440], ["tIns", 45720], ["rIns", 91440], ["bIns", 45720]].map(function (k) { return Math.round(Number(bp.getAttribute(k[0]) != null ? bp.getAttribute(k[0]) : k[1]) / 914400 * 1000) / 1000; }) : [0.1, 0.05, 0.1, 0.05];
          var paras = [];
          kids(tb, NS_A, "p").forEach(function (p) {
            var pPr = kid(p, NS_A, "pPr"), para = { al: ({ l: "l", ctr: "c", r: "r" })[(pPr && pPr.getAttribute("algn")) || "l"] || "l", runs: [] };
            if (pPr) {
              var sa = path(pPr, ["a:spcAft", "a:spcPts"]), sb = path(pPr, ["a:spcBef", "a:spcPts"]), ls = path(pPr, ["a:lnSpc", "a:spcPct"]);
              if (sa) para.sa = Number(sa.getAttribute("val")) / 100; if (sb) para.sb = Number(sb.getAttribute("val")) / 100; if (ls) para.ls = Number(ls.getAttribute("val")) / 100000;
            }
            for (var r = p.firstElementChild; r; r = r.nextElementSibling) {
              if (r.localName === "br") { para.runs.push({ t: "\n" }); continue; }
              if (r.localName !== "r" && r.localName !== "fld") continue;
              var rp = kid(r, NS_A, "rPr"), tt = kid(r, NS_A, "t"), run = { t: (tt && tt.textContent) || "" };
              if (rp) {
                if (rp.getAttribute("sz")) run.sz = Number(rp.getAttribute("sz")) / 100;
                if (rp.getAttribute("b") === "1") run.b = 1; if (rp.getAttribute("i") === "1") run.i = 1;
                var c = colorOf(rp); if (c) run.c = c;
                var f = kid(rp, NS_A, "latin"); if (f && f.getAttribute("typeface") && f.getAttribute("typeface").charAt(0) !== "+") run.f = f.getAttribute("typeface");
              }
              para.runs.push(run);
            }
            paras.push(para);
          });
          var txt = paras.map(function (p) { return p.runs.map(function (r) { return r.t; }).join(""); }).join("");
          if (!txt && !it.fill && !it.line && !bf) return;
          if (!txt && bf && !it.fill) {
            var bl = path(bf, ["a:blip"]); if (!bl) return;
            return addImage(bl.getAttributeNS(NS_R, "embed"), ctx.rels, nm).then(function (aid) { if (!aid) { skipped++; return; } it.t = "img"; it.src = aid; delete it.paras; out.push(it); });
          }
          if (/^ADD AUDIO:/.test(txt)) { it = { id: it.id, t: "audio", x: it.x, y: it.y, w: Math.min(it.w, 5.6), h: 0.6, step: 0, label: txt.replace(/^ADD AUDIO:/, "").trim(), src: null }; out.push(it); return; }
          it.t = (!it.fill && !it.line) ? "text" : "box";
          it.paras = paras.length ? paras : [{ al: "l", runs: [{ t: "" }] }];
          out.push(it);
        });
      })(el);
      return chain;
    }

    return JSZip.loadAsync(buf).then(function (z) {
      zip = z;
      return Promise.all([xml("ppt/presentation.xml"), relsOf("ppt/presentation.xml"), xml("ppt/theme/theme1.xml")]);
    }).then(function (r) {
      var pres = r[0], prels = r[1], th = r[2];
      if (!pres) throw new Error("This does not look like a PowerPoint (.pptx) file.");
      var sz = all(pres, NS_P, "sldSz")[0]; if (sz) { sldW = Number(sz.getAttribute("cx")); sldH = Number(sz.getAttribute("cy")); }
      if (th) { var cs = all(th, NS_A, "clrScheme")[0]; if (cs) kids(cs, NS_A, null).length, Array.prototype.forEach.call(cs.children, function (n) { var c = n.firstElementChild; if (c) theme[n.localName] = c.getAttribute("val") || c.getAttribute("lastClr"); }); }
      var ids = all(pres, NS_P, "sldId").map(function (n) { return n.getAttributeNS(NS_R, "id"); });
      var sx = W * 914400 / sldW, sy = H * 914400 / sldH;
      var slides = [], notes = {}, p = Promise.resolve();
      ids.forEach(function (rid, si) {
        p = p.then(function () {
          var rel = prels[rid]; if (!rel) return;
          return Promise.all([xml(rel.target), relsOf(rel.target)]).then(function (d) {
            var doc = d[0], rels = d[1]; if (!doc) return;
            var layoutRel = Object.keys(rels).map(function (k) { return rels[k]; }).filter(function (x) { return /slideLayout$/.test(x.type); })[0];
            var chainP = layoutRel ? Promise.all([xml(layoutRel.target), relsOf(layoutRel.target)]).then(function (l) {
              var mrel = Object.keys(l[1]).map(function (k) { return l[1][k]; }).filter(function (x) { return /slideMaster$/.test(x.type); })[0];
              return (mrel ? xml(mrel.target) : Promise.resolve(null)).then(function (m) { return [l[0], m]; });
            }) : Promise.resolve([]);
            return chainP.then(function (chain) {
              var bgc = path(doc.documentElement, ["p:cSld", "p:bg", "p:bgPr"]), bg = (bgc && colorOf(bgc)) || "#FFFFFF";
              var steps = {};
              all(doc, NS_P, "cTn").forEach(function (c) {
                if (c.getAttribute("nodeType") !== "mainSeq") return;
                var lst = kid(c, NS_P, "childTnLst"); if (!lst) return;
                kids(lst, NS_P, "par").forEach(function (par, n) { all(par, NS_P, "spTgt").forEach(function (t) { steps[Number(t.getAttribute("spid"))] = n + 1; }); });
              });
              var tree = path(doc.documentElement, ["p:cSld", "p:spTree"]), out = [], sid = "s" + (si + 1);
              var ctx = { rels: rels, chain: chain };
              return (tree ? shapeItems(tree, ctx, { ox: 0, oy: 0, cox: 0, coy: 0, sx: sx, sy: sy }, steps, out) : Promise.resolve()).then(function () {
                // unique item ids
                var seen = {}; out.forEach(function (it, i) { if (seen[it.id]) it.id = it.id + "_" + i; seen[it.id] = 1; });
                slides.push({ id: sid, bg: bg, tr: "fade", items: out });
                var nrel = Object.keys(rels).map(function (k) { return rels[k]; }).filter(function (x) { return /notesSlide$/.test(x.type); })[0];
                if (!nrel) return;
                return xml(nrel.target).then(function (nd) {
                  if (!nd) return; var txt = [];
                  all(nd, NS_P, "sp").forEach(function (sp) { var ph = path(sp, ["p:nvSpPr", "p:nvPr", "p:ph"]); if (ph && ph.getAttribute("type") === "body") kids(path(sp, ["p:txBody"]), NS_A, "p").forEach(function (pp) { txt.push(all(pp, NS_A, "t").map(function (t) { return t.textContent; }).join("")); }); });
                  var s = txt.join("\n").trim(); if (s) notes[sid] = s;
                });
              });
            });
          });
        });
      });
      return p.then(function () { return { slides: slides, notes: notes, assets: assets, skipped: skipped }; });
    });
  }

  window.CLEAR_PPTX = { convert: convert };
})();
