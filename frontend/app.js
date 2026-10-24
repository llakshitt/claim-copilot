(() => {
  "use strict";
  const API = (window.CLAIM_API || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const CATEGORIES = [
    ["room", "Room rent"], ["doctor_fees", "Doctor fees"], ["surgery", "Surgery"], ["ot_charges", "OT charges"],
    ["nursing", "Nursing"], ["diagnostics", "Tests and scans"], ["procedure", "Procedure"],
    ["pharmacy", "Medicines"], ["consumables", "Consumables"], ["non_payable", "Not payable (known)"], ["other", "Other"],
  ];
  const FIELD_CLAUSE = { "f-si": "sum_insured", "f-cap": "room_rent", "f-pct": "room_rent", "f-copay": "copay", "f-ded": "deductible" };
  const state = { terms: blankTerms(), result: null, findings: [], req: 0, letterEdited: false, demo: false, demoRunning: false, flash: null };

  function blankTerms() { return { subLimits: {}, waiting: {}, exclusions: [], clauses: {} }; }

  // ---------- helpers
  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const num = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/[,\s]/g, "").replace(/^rs\.?/i, "");
    if (s === "") return null;
    return /^-?\d*\.?\d+$/.test(s) ? Number(s) : NaN;
  };
  const group = (n) => Number(n).toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
  const rs = (n) => "Rs " + group(n);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const pageName = (c) => c.ref + (c.page ? ", page " + c.page : "");

  // ---------- server status and API
  function setStatus(stateName, text) {
    $("api-status").dataset.state = stateName;
    $("api-status-text").textContent = text;
  }
  async function warmUp() {
    setStatus("checking", "Waking the server (free hosting, up to a minute)");
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
      const r = await fetch(API + "/health", { signal: ctl.signal }); clearTimeout(t);
      if (!r.ok) throw new Error();
      setStatus("ready", "Server ready");
    } catch (_) { setStatus("down", "Server not responding"); }
  }
  function friendly(e) {
    if (e.name === "AbortError") return "The server took too long to answer. It may still be waking up, so try again in a moment.";
    if (e instanceof TypeError) return "Could not reach the server. Check your connection and try again.";
    return e.message || "Something went wrong. Try again.";
  }
  async function api(path, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 80000);
    try {
      const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      let data = {}; try { data = await r.json(); } catch (_) {}
      if (!r.ok) throw new Error(data.error || "The server could not process that request.");
      if ($("api-status").dataset.state !== "ready") setStatus("ready", "Server ready");
      return data;
    } finally { clearTimeout(t); }
  }

  // ---------- inputs and validation
  function fieldError(id, msg) {
    const input = $(id), err = $("e-" + id.slice(2));
    if (!err) return;
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    err.textContent = msg || ""; err.hidden = !msg;
  }
  function money(id, { required = false } = {}) {
    const v = num($(id).value);
    if (v === null) { fieldError(id, required && $(id).dataset.touched ? "Enter the sum insured from your policy." : ""); return { v: null, ok: !required }; }
    if (Number.isNaN(v) || v < 0 || (required && v === 0)) { fieldError(id, "Enter an amount in rupees, for example 5,00,000."); return { v: null, ok: false }; }
    fieldError(id, ""); return { v, ok: true };
  }
  function pct(id) {
    const v = num($(id).value);
    if (v === null) { fieldError(id, ""); return { v: null, ok: true }; }
    if (Number.isNaN(v) || v < 0 || v > 100) { fieldError(id, "Enter a percentage between 0 and 100."); return { v: null, ok: false }; }
    fieldError(id, ""); return { v, ok: true };
  }
  function days() {
    const v = num($("f-age").value);
    if (v === null) { fieldError("f-age", ""); return { v: null, ok: true }; }
    if (Number.isNaN(v) || v < 0 || !Number.isInteger(v)) { fieldError("f-age", "Enter a whole number of days."); return { v: null, ok: false }; }
    fieldError("f-age", ""); return { v, ok: true };
  }

  function collect() {
    const si = money("f-si", { required: true }), cap = money("f-cap"), ded = money("f-ded"), pc = pct("f-pct"), cp = pct("f-copay"), age = days();
    const rows = readRows();
    const fieldsOk = si.ok && cap.ok && ded.ok && pc.ok && cp.ok && age.ok && rows.ok;
    const ready = fieldsOk && si.v > 0 && rows.lines.length > 0;
    const policy = { sum_insured: si.v, clauses: state.terms.clauses };
    if (cap.v) policy.room_rent_cap_per_day = cap.v;
    if (pc.v) policy.room_rent_cap_pct_of_si = pc.v;
    if (cp.v) policy.copay_pct = cp.v;
    if (ded.v) policy.deductible = ded.v;
    if (Object.keys(state.terms.subLimits).length) policy.sub_limits = state.terms.subLimits;
    if (Object.keys(state.terms.waiting).length) policy.waiting_period_days = state.terms.waiting;
    if (state.terms.exclusions.length) policy.exclusions = state.terms.exclusions;
    const claim = { lines: rows.lines, condition: $("f-cond").value.trim() || null };
    if (age.v != null) claim.days_since_policy_start = age.v;
    return { ready, fieldsOk, policy, claim, procedure: $("f-proc").value.trim() || null, hasRows: rows.lines.length > 0 };
  }

  // ---------- bill rows
  function addRow(d = {}, focus = false) {
    const item = h("input", { "aria-label": "Item", autocomplete: "off", placeholder: "As written on the bill", value: d.description || "" });
    const sel = h("select", { "aria-label": "Type" });
    for (const [v, t] of CATEGORIES) sel.append(h("option", { value: v, text: t }));
    sel.value = d.category || "other";
    const dys = h("input", { "aria-label": "Days", inputmode: "numeric", autocomplete: "off", value: d.days ?? "" });
    const amt = h("input", { "aria-label": "Amount in rupees", inputmode: "decimal", autocomplete: "off", value: d.amount != null ? group(d.amount) : "" });
    const rm = h("button", { class: "rm", type: "button", "aria-label": "Remove this row", text: "×" });
    const tr = h("tr", {},
      h("td", { "data-label": "Item" }, item), h("td", { "data-label": "Type" }, sel),
      h("td", { "data-label": "Days", class: "r" }, dys), h("td", { "data-label": "Amount (Rs)", class: "r" }, amt), h("td", {}, rm));
    const syncDays = () => { const room = sel.value === "room"; dys.disabled = !room; if (!room) dys.value = ""; };
    sel.addEventListener("change", syncDays); syncDays();
    amt.addEventListener("blur", () => { const v = num(amt.value); if (v != null && !Number.isNaN(v)) amt.value = group(v); });
    amt.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return; e.preventDefault();
      const next = tr.nextElementSibling;
      if (next) next.querySelector("input").focus(); else addRow({}, true);
    });
    rm.addEventListener("click", () => { const prev = tr.previousElementSibling || tr.nextElementSibling; tr.remove(); if (!$("lines").children.length) addRow(); else if (prev) prev.querySelector("input").focus(); changed(); });
    tr.addEventListener("input", changed);
    tr.addEventListener("change", changed);
    $("lines").append(tr);
    if (focus) item.focus();
    return tr;
  }
  function readRows() {
    const lines = []; let ok = true;
    for (const tr of $("lines").children) {
      const [item, sel, dys, amt] = [tr.querySelector("td:nth-child(1) input"), tr.querySelector("select"), tr.querySelector("td:nth-child(3) input"), tr.querySelector("td:nth-child(4) input")];
      const a = num(amt.value); const d = num(dys.value);
      const bad = (a !== null && (Number.isNaN(a) || a < 0)) || (d !== null && (Number.isNaN(d) || d <= 0 || !Number.isInteger(d)));
      amt.setAttribute("aria-invalid", String(bad && (Number.isNaN(a) || a < 0)));
      dys.setAttribute("aria-invalid", String(d !== null && (Number.isNaN(d) || d <= 0 || !Number.isInteger(d))));
      if (bad) { ok = false; continue; }
      if (!a) continue;
      const line = { description: item.value.trim() || "Item", category: sel.value, amount: a };
      if (d) line.days = d;
      lines.push(line);
    }
    const err = $("e-bill"); err.hidden = ok; if (!ok) err.textContent = "Check the highlighted rows: amounts must be numbers and days whole numbers.";
    $("bill-total").textContent = rs(lines.reduce((s, l) => s + l.amount, 0)); $("k-bill").textContent = $("bill-total").textContent;
    return { lines, ok };
  }

  // ---------- estimate
  const schedule = debounce(() => { if (current === "result") refresh(); }, 650);
  function changed() { collect(); schedule(); updateNav(); }

  function showOnly(which) {
    $("est-empty").hidden = which !== "empty"; $("est-error").hidden = which !== "error"; $("est-body").hidden = which !== "body";
    if (which !== "body") setKpis(null);
    updateNav();
  }
  function setKpis(est) {
    const set = (id, t) => { $(id).textContent = t; };
    const cards = document.querySelectorAll("#kpis .kpi");
    if (!est) { set("k-bill", $("bill-total").textContent); set("k-pay", "Not yet"); set("k-you", "Not yet"); cards.forEach((c) => c.classList.remove("live")); return; }
    const total = Number(est.total_billed), pay = Number(est.payable), you = Number(est.patient_pays);
    const pp = total ? Math.round(pay / total * 100) : 0;
    set("k-bill", rs(total)); set("k-pay", rs(pay)); set("k-you", rs(you));
    set("k-pay-pct", pp + "%"); set("k-you-pct", (100 - pp) + "%");
    cards.forEach((c) => c.classList.add("live"));
  }
  async function refresh() {
    const c = collect();
    if (!c.ready) { state.result = null; $("est-state").textContent = ""; showOnly("empty"); return; }
    const mine = ++state.req;
    $("est-state").textContent = "Updating";
    try {
      const [est, aud] = await Promise.all([
        api("/api/estimate", { policy: c.policy, claim: c.claim }),
        api("/api/audit", { claim: { lines: c.claim.lines }, procedure: c.procedure }),
      ]);
      if (mine !== state.req) return;
      state.result = est; state.findings = aud.findings || [];
      renderEstimate(est, state.findings, c); $("est-state").textContent = ""; showOnly("body");
    } catch (e) {
      if (mine !== state.req) return;
      $("est-error-text").textContent = friendly(e); $("est-state").textContent = ""; showOnly("error");
      if (e.name === "AbortError" || e instanceof TypeError) setStatus("down", "Server not responding");
    }
  }

  function renderEstimate(est, findings, c) {
    const total = Number(est.total_billed), pay = Number(est.payable), you = Number(est.patient_pays);
    $("bar-pay").style.width = total ? (pay / total * 100) + "%" : "0%";
    $("bar-you").style.width = total ? (you / total * 100) + "%" : "0%";
    const r = $("receipt"); r.replaceChildren();
    const row = (cls, what, amt) => h("div", { class: "r-row " + cls }, h("span", { class: "what", text: what }), h("span", { class: "amt", text: amt }));
    r.append(row("", "Hospital bill", rs(total)));
    for (const s of est.steps) {
      r.append(row("r-cut", s.explanation, "− " + rs(Math.abs(Number(s.effect)))));
      if (s.clause) r.append(h("p", { class: "r-cite", text: pageName(s.clause) + ": “" + s.clause.text + "”" }));
    }
    r.append(row("r-sum pay", "Insurer pays about", rs(pay)));
    r.append(row("r-sum you", "You pay about", rs(you)));
    for (const w of est.warnings) r.append(h("p", { class: "r-warn", text: w }));
    const list = $("findings-list"); list.replaceChildren();
    for (const f of findings) list.append(h("li", { text: f.detail }));
    $("findings").hidden = findings.length === 0;
    setKpis(est);
    const used = $("used-list"); used.replaceChildren();
    const add = (k, v) => { used.append(h("dt", { text: k }), h("dd", { text: v })); };
    const p = c.policy;
    add("Sum insured", rs(p.sum_insured));
    add("Room rent cap per day", p.room_rent_cap_per_day ? rs(p.room_rent_cap_per_day) : "None");
    if (p.room_rent_cap_pct_of_si) add("Room rent cap", p.room_rent_cap_pct_of_si + "% of sum insured");
    add("Co-pay", (p.copay_pct || 0) + "%");
    add("Deductible", rs(p.deductible || 0));
    for (const [k, v] of Object.entries(state.terms.subLimits)) add("Sub-limit, " + k.replace(/_/g, " "), rs(v));
    for (const [k, v] of Object.entries(state.terms.waiting)) add("Waiting period, " + k, v + " days");
    for (const k of state.terms.exclusions) add("Exclusion", k);
    if (c.claim.condition) add("Condition", c.claim.condition);
    if (c.claim.days_since_policy_start != null) add("Days since policy start", String(c.claim.days_since_policy_start));
  }
  $("est-retry").onclick = refresh;
  $("print").onclick = () => { $("print-date").textContent = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }); window.print(); };

  // ---------- policy reading and terms
  function renderTerms() {
    const t = state.terms, ul = $("terms-list"); ul.replaceChildren();
    const chip = (text, drop) => { const b = h("button", { type: "button", "aria-label": "Remove " + text, text: "×" }); b.onclick = () => { drop(); renderTerms(); changed(); }; ul.append(h("li", { class: "chip" }, text, b)); };
    for (const [k, v] of Object.entries(t.subLimits)) chip("Limit on " + k.replace(/_/g, " ") + ": " + rs(v), () => delete t.subLimits[k]);
    for (const [k, v] of Object.entries(t.waiting)) chip("Waiting period, " + k + ": " + v + " days", () => delete t.waiting[k]);
    t.exclusions.forEach((k, i) => chip("Excluded: " + k, () => t.exclusions.splice(i, 1)));
    $("terms").hidden = ul.children.length === 0;
  }
  function renderCitations(rejected = []) {
    const ul = $("citations-list"); ul.replaceChildren();
    for (const c of Object.values(state.terms.clauses)) ul.append(h("li", {}, h("strong", { text: pageName(c) + ": " }), h("span", { class: "q", text: "“" + c.text + "”" })));
    const why = { "quote not found in policy text": "the quoted words are not in your text", "no supporting quote": "no supporting words were given" };
    for (const [f, reason] of rejected) ul.append(h("li", { class: "skip-note", text: "Not applied: " + f.replace(/[_:]/g, " ") + " (" + (why[reason] || reason) + ")." }));
    $("citations").hidden = ul.children.length === 0;
  }
  for (const id of Object.keys(FIELD_CLAUSE)) {
    $(id).addEventListener("input", () => { delete state.terms.clauses[FIELD_CLAUSE[id]]; renderCitations(); });
  }
  for (const id of ["f-si", "f-cap", "f-ded"]) {
    $(id).addEventListener("blur", () => { $(id).dataset.touched = "1"; const v = num($(id).value); if (v != null && !Number.isNaN(v)) $(id).value = group(v); collect(); });
  }
  for (const id of ["f-si", "f-cap", "f-pct", "f-copay", "f-ded", "f-cond", "f-age", "f-proc"]) $(id).addEventListener("input", changed);

  async function readPolicy() {
    const text = $("policy-text").value.trim(), st = $("read-status");
    if (!text) { st.textContent = "Paste some policy text first."; st.className = "status bad"; return false; }
    $("read-policy").disabled = true; st.className = "status"; st.textContent = "Reading your policy. This can take up to a minute the first time.";
    let found = false;
    try {
      const d = await api("/api/extract", { text });
      if (!d.policy) { st.textContent = "We could not find the sum insured in that text. Enter the terms by hand."; st.className = "status bad"; renderCitations(d.rejected); }
      else {
        const p = d.policy, cl = p.clauses || {};
        state.terms = { subLimits: p.sub_limits || {}, waiting: p.waiting_period_days || {}, exclusions: p.exclusions || [], clauses: cl };
        if (cl.sum_insured) $("f-si").value = group(p.sum_insured);
        if (cl.room_rent) { $("f-cap").value = p.room_rent_cap_per_day ? group(p.room_rent_cap_per_day) : ""; $("f-pct").value = p.room_rent_cap_pct_of_si || ""; }
        if (cl.copay) $("f-copay").value = Number(p.copay_pct) || "";
        if (cl.deductible) $("f-ded").value = group(p.deductible);
        renderTerms(); renderCitations(d.rejected);
        st.textContent = "Done. Check each value against your policy before relying on it."; found = true; changed();
      }
    } catch (e) { st.textContent = friendly(e); st.className = "status bad"; }
    $("read-policy").disabled = false;
    return found;
  }
  $("read-policy").onclick = readPolicy;

  // ---------- document upload (PDF text is read in the browser; images and scans go to the OCR endpoint)
  const MAX_BYTES = 15 * 1024 * 1024, MAX_OCR_PAGES = 6, MAX_PAGES = 40, MAX_CHARS = 60000;
  async function canvasToJpeg(canvas) {
    for (const q of [0.82, 0.65, 0.5]) {
      const url = canvas.toDataURL("image/jpeg", q);
      if (url.length < 4_500_000) return url;
    }
    throw new Error("That image is too large to read. Try a smaller photo.");
  }
  async function imageToJpeg(blob) {
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch { throw new Error("This browser cannot open that image. Try a JPEG or PNG, or a screenshot."); }
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    return canvasToJpeg(c);
  }
  async function ocr(dataUrl) { return (await api("/api/ocr", { image: dataUrl })).text || ""; }
  let pdfjsLib = null;
  async function pdfToText(file, say) {
    if (!pdfjsLib) {
      try { pdfjsLib = await import("./vendor/pdf.mjs"); } catch { throw new Error("The PDF reader could not load. Refresh the page, or upload a photo of the pages."); }
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", location.href).href;
    }
    let doc;
    try { doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise; }
    catch (e) { throw new Error(e && e.name === "PasswordException" ? "That PDF is password protected. Remove the password and try again." : "We could not open that PDF. Try a photo or screenshot of the pages instead."); }
    const pages = [], total = Math.min(doc.numPages, MAX_PAGES); let ocrUsed = 0, skipped = 0;
    for (let n = 1; n <= total; n++) {
      say("Reading page " + n + " of " + total);
      const page = await doc.getPage(n);
      const tc = await page.getTextContent(); let t = "";
      for (const it of tc.items) { t += it.str; t += it.hasEOL ? "\n" : " "; }
      t = t.replace(/[ \t]+\n/g, "\n").trim();
      if (t.length < 30) {
        if (ocrUsed >= MAX_OCR_PAGES) { skipped++; continue; }
        ocrUsed++; say("Reading scanned page " + n + " of " + total);
        const vp0 = page.getViewport({ scale: 1 }), scale = Math.min(2.5, 1600 / Math.max(vp0.width, vp0.height) * 1.0 + 0.0001);
        const vp = page.getViewport({ scale }), c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        t = (await ocr(await canvasToJpeg(c))).trim();
      }
      if (t) pages.push(t);
    }
    if (doc.numPages > total) skipped += doc.numPages - total;
    const out = pages.join("\n\n");
    return { text: out, note: skipped ? skipped + " page(s) were not read (limit reached)." : "" };
  }
  async function fileToText(file, say) {
    if (file.size > MAX_BYTES) throw new Error(file.name + " is over 15 MB. Try a smaller or compressed copy.");
    if (file.type === "text/plain" || /\.txt$/i.test(file.name)) return { text: await file.text(), note: "" };
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return pdfToText(file, say);
    if (file.type.startsWith("image/")) { say("Reading the image"); return { text: await ocr(await imageToJpeg(file)), note: "" }; }
    throw new Error(file.name + " is not supported. Use a PDF, a photo or screenshot, or a .txt file.");
  }
  async function filesToText(files, say) {
    const parts = [], notes = [];
    for (const f of files) {
      const r = await fileToText(f, (m) => say(files.length > 1 ? f.name + ": " + m : m));
      if (r.text.trim()) parts.push(r.text.trim()); else notes.push("No readable text found in " + f.name + ".");
      if (r.note) notes.push(r.note);
    }
    return { text: parts.join("\n\n"), notes };
  }
  function wireDrop(zoneId, inputId, pickId, handler) {
    const zone = $(zoneId), input = $(inputId);
    $(pickId).onclick = () => input.click();
    input.onchange = () => { const fs = [...input.files]; input.value = ""; if (fs.length) handler(fs); };
    for (const ev of ["dragenter", "dragover"]) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); });
    for (const ev of ["dragleave", "drop"]) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("over"); });
    zone.addEventListener("drop", (e) => { const fs = [...(e.dataTransfer?.files || [])]; if (fs.length) handler(fs); });
  }
  function busy(zoneId, pickId, on) { $(zoneId).classList.toggle("busy", on); $(pickId).disabled = on; }

  async function processPolicy(files) {
    const st = $("policy-up-status"); busy("drop-policy", "pick-policy", true); st.className = "note"; let ok = false;
    try {
      const r = await filesToText(files, (m) => { st.textContent = m; });
      if (!r.text) { st.textContent = r.notes.join(" ") || "No readable text found."; st.className = "note bad"; }
      else {
        const box = $("policy-text"); box.value = (box.value.trim() ? box.value.trim() + "\n\n" : "") + r.text; box.value = box.value.slice(0, MAX_CHARS);
        st.textContent = "Read " + files.length + " file(s). " + r.notes.join(" ") + " Finding the terms.";
        ok = await readPolicy();
        st.textContent = ok ? "Terms found. Check them below, then continue." : "We read the document but could not find the sum insured. Enter the terms below.";
        st.className = ok ? "note" : "note bad";
      }
    } catch (e) { st.textContent = friendly(e); st.className = "note bad"; }
    busy("drop-policy", "pick-policy", false);
    return ok;
  }
  async function processBill(files) {
    const st = $("bill-up-status"); busy("drop-bill", "pick-bill", true); st.className = "note"; let ok = false;
    try {
      const r = await filesToText(files, (m) => { st.textContent = m; });
      if (!r.text) { st.textContent = r.notes.join(" ") || "No readable text found."; st.className = "note bad"; }
      else {
        st.textContent = "Finding the line items. This can take up to a minute.";
        const d = await api("/api/bill-lines", { text: r.text.slice(0, MAX_CHARS) });
        if (!d.lines.length) { st.textContent = "We could not find line items with amounts in that document. Type the rows by hand or try a clearer copy."; st.className = "note bad"; }
        else {
          for (const tr of [...$("lines").children]) { const a = tr.querySelector("td:nth-child(4) input").value.trim(), n = tr.querySelector("td:nth-child(1) input").value.trim(); if (!a && !n) tr.remove(); }
          for (const l of d.lines) addRow({ description: l.description, category: l.category, amount: Number(l.amount), days: l.days });
          changed(); ok = true;
          st.textContent = "Added " + d.lines.length + " row(s). Check every row against your bill; the type and days are our best guess." + (d.rejected ? " " + d.rejected + " line(s) were ignored because their amount was not found in the document." : "") + (r.notes.length ? " " + r.notes.join(" ") : "");
        }
      }
    } catch (e) { st.textContent = friendly(e); st.className = "note bad"; }
    busy("drop-bill", "pick-bill", false);
    return ok;
  }
  wireDrop("drop-policy", "policy-file", "pick-policy", processPolicy);
  wireDrop("drop-bill", "bill-file", "pick-bill", processBill);
  $("add-line").onclick = () => addRow({}, true);

  // ---------- letter
  const letterBody = () => {
    const body = { level: $("g-level").value, reason: $("g-reason").value.trim() };
    const map = { name: "g-name", insurer: "g-insurer", policy_no: "g-policy", claim_no: "g-claim" };
    for (const [k, id] of Object.entries(map)) if ($(id).value.trim()) body[k] = $(id).value.trim();
    const amt = num($("g-amt").value); if (amt) body.disputed_amount = group(amt);
    const first = state.result && state.result.steps.find((s) => s.clause);
    if (first) { body.clause_ref = pageName(first.clause); body.clause_text = first.clause.text; }
    return body;
  };
  async function generateLetter() {
    const st = $("g-status"); st.className = "status"; st.textContent = "Building the letter";
    try { const d = await api("/api/grievance", letterBody()); $("letter-out").value = d.letter; state.letterEdited = false; st.textContent = ""; }
    catch (e) { st.textContent = friendly(e); st.className = "status bad"; }
  }
  const regenSoon = debounce(() => { if (!state.letterEdited) generateLetter(); }, 600);
  $("open-letter").onclick = () => {
    $("dlg-letter").showModal(); state.letterEdited = false; generateLetter();
  };
  for (const id of ["g-level", "g-name", "g-insurer", "g-policy", "g-claim", "g-amt", "g-reason"]) $(id).addEventListener("input", regenSoon);
  $("letter-out").addEventListener("input", () => { state.letterEdited = true; });
  $("g-regen").onclick = () => { state.letterEdited = false; generateLetter(); };
  $("g-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("letter-out").value); $("g-status").textContent = "Copied to the clipboard."; $("g-status").className = "status"; }
    catch (_) { $("g-status").textContent = "Copy failed. Select the text and copy it."; $("g-status").className = "status bad"; }
  };
  $("g-download").onclick = () => {
    const url = URL.createObjectURL(new Blob([$("letter-out").value], { type: "text/plain" }));
    const a = h("a", { href: url, download: "complaint-letter.txt" }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ---------- dialogs
  const openDlg = (name) => $("dlg-" + name).showModal();
  $("open-method").onclick = () => openDlg("method");
  document.addEventListener("click", (e) => { const t = e.target.closest("[data-open]"); if (t) openDlg(t.dataset.open); });
  document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

  // ---------- reset
  function resetAll() {
    for (const id of ["f-si", "f-cap", "f-pct", "f-copay", "f-ded", "f-cond", "f-age", "f-proc", "policy-text", "g-name", "g-insurer", "g-policy", "g-claim", "g-amt", "g-reason", "letter-out"]) { $(id).value = ""; }
    state.terms = blankTerms(); state.result = null; state.demo = false; $("demo-note").hidden = true; renderTerms(); renderCitations();
    $("lines").replaceChildren(); addRow(); addRow();
    for (const id of ["read-status", "policy-up-status", "bill-up-status"]) { $(id).textContent = ""; }
    for (const id of ["f-si", "f-cap", "f-pct", "f-copay", "f-ded", "f-age"]) { fieldError(id, ""); delete $(id).dataset.touched; }
    showOnly("empty"); collect();
  }
  $("reset").onclick = () => { resetAll(); go("start"); };

  // ---------- screens: one step at a time, addressable by #hash so Back works
  const ORDER = ["start", "policy", "bill", "details", "result"];
  let current = "start";
  function gate(name) {
    const c = collect();
    if (ORDER.indexOf(name) >= 2 && !(num($("f-si").value) > 0 && c.fieldsOk)) { $("f-si").dataset.touched = "1"; collect(); return { ok: false, to: "policy", why: "Add the sum insured first." }; }
    if (ORDER.indexOf(name) >= 3 && !c.hasRows) return { ok: false, to: "bill", why: "Add at least one bill row first." };
    return { ok: true };
  }
  function show(name) {
    current = name;
    document.querySelectorAll(".screen").forEach((s) => { s.hidden = s.dataset.screen !== name; });
    $("stepper").hidden = name === "start";
    document.querySelectorAll("#stepper button").forEach((b) => {
      const i = ORDER.indexOf(b.dataset.go); b.classList.toggle("done", i < ORDER.indexOf(name) && i > 0);
      if (b.dataset.go === name) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    });
    if (name === "result") refresh();
    updateNav(); window.scrollTo({ top: 0 }); const m = $("main"); m.focus({ preventScroll: true });
  }
  function go(name) {
    const g = gate(name);
    if (!g.ok) { name = g.to; state.flash = { text: g.why, bad: true }; }
    if (location.hash !== "#" + name) location.hash = name; else show(name);
  }
  window.addEventListener("hashchange", () => {
    const name = location.hash.slice(1); if (!ORDER.includes(name)) return show("start");
    const g = gate(name); if (!g.ok) { location.hash = g.to; return; } show(name);
  });
  function hint(text, bad) { const e = $("nav-hint"); e.textContent = text; e.classList.toggle("bad", !!bad); }
  function updateNav() {
    const bar = $("stepnav"); bar.hidden = current === "start" || current === "result";
    const i = ORDER.indexOf(current);
    $("nav-back").onclick = () => go(ORDER[Math.max(0, i - 1)]);
    $("nav-next").onclick = () => go(ORDER[Math.min(ORDER.length - 1, i + 1)]);
    $("nav-next").textContent = current === "details" ? "See my estimate" : "Continue";
    if (current === "policy") { const v = num($("f-si").value); hint(v > 0 ? "Sum insured " + rs(v) : "Add the sum insured to continue"); }
    else if (current === "bill") hint("Bill total " + $("bill-total").textContent);
    else if (current === "details") hint("All optional");
    if (state.flash) { hint(state.flash.text, state.flash.bad); state.flash = null; }
    if (current === "result") $("empty-why").textContent = num($("f-si").value) > 0 ? "Add at least one bill row to see the estimate." : "Add the sum insured and at least one bill row to see the estimate.";
  }
  document.addEventListener("click", (e) => { const t = e.target.closest("[data-go]"); if (t) go(t.dataset.go); });

  // ---------- demo: runs the fictional documents through the same upload steps as real ones
  async function fetchDemo(path, type) {
    const r = await fetch(path); if (!r.ok) throw new Error("Could not load the demo document.");
    return new File([await r.blob()], path.split("/").pop(), { type });
  }
  async function runDemo() {
    if (state.demoRunning) return; state.demoRunning = true;
    for (const id of ["demo", "pick-policy", "pick-bill"]) $(id).disabled = true;
    try {
      resetAll(); state.demo = true; go("policy");
      const okP = await processPolicy([await fetchDemo("demo/demo-policy.pdf", "application/pdf")]);
      if (!okP) throw new Error("The demo policy could not be read. Try again in a minute, or enter the terms by hand.");
      go("bill");
      const okB = await processBill([await fetchDemo("demo/demo-hospital-bill.pdf", "application/pdf")]);
      if (!okB) throw new Error("The demo bill could not be read. Try again in a minute, or enter the rows by hand.");
      $("f-cond").value = "Inguinal hernia repair"; $("f-age").value = "924";
      $("demo-note").hidden = false; changed(); go("details");
      await new Promise((r) => setTimeout(r, 900)); go("result");
    } catch (e) { state.flash = { text: friendly(e), bad: true }; updateNav(); }
    state.demoRunning = false;
    for (const id of ["demo", "pick-policy", "pick-bill"]) $(id).disabled = false;
  }
  $("demo").onclick = runDemo;

  // ---------- start
  addRow(); addRow(); showOnly("empty"); collect(); warmUp();
  { const name = location.hash.slice(1); if (ORDER.includes(name) && name !== "start" && gate(name).ok) show(name); else { if (name) history.replaceState(null, "", location.pathname + location.search); show("start"); } }
})();
