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
  const state = { terms: blankTerms(), result: null, findings: [], req: 0, letterEdited: false };

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
  const group = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
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
    $("bill-total").textContent = rs(lines.reduce((s, l) => s + l.amount, 0));
    return { lines, ok };
  }

  // ---------- estimate
  const schedule = debounce(refresh, 650);
  function changed() { collect(); schedule(); }

  function showOnly(which) {
    $("est-empty").hidden = which !== "empty"; $("est-error").hidden = which !== "error"; $("est-body").hidden = which !== "body";
    $("mbar").hidden = which !== "body";
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
    $("mbar-v").textContent = rs(pay);
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

  $("read-policy").onclick = async () => {
    const text = $("policy-text").value.trim(), st = $("read-status");
    if (!text) { st.textContent = "Paste some policy text first."; st.className = "status bad"; return; }
    $("read-policy").disabled = true; st.className = "status"; st.textContent = "Reading your policy. This can take up to a minute the first time.";
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
        st.textContent = "Done. Check each value against your policy before relying on it."; changed();
      }
    } catch (e) { st.textContent = friendly(e); st.className = "status bad"; }
    $("read-policy").disabled = false;
  };

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

  // ---------- sample and reset
  function resetAll() {
    for (const id of ["f-si", "f-cap", "f-pct", "f-copay", "f-ded", "f-cond", "f-age", "f-proc", "policy-text", "g-name", "g-insurer", "g-policy", "g-claim", "g-amt", "g-reason", "letter-out"]) { $(id).value = ""; }
    state.terms = blankTerms(); state.result = null; renderTerms(); renderCitations();
    $("lines").replaceChildren(); addRow(); addRow(); $("read-status").textContent = "";
    for (const id of ["f-si", "f-cap", "f-pct", "f-copay", "f-ded", "f-age"]) { fieldError(id, ""); delete $(id).dataset.touched; }
    showOnly("empty"); collect();
  }
  $("reset").onclick = resetAll;
  $("sample").onclick = () => {
    resetAll();
    $("f-si").value = "5,00,000"; $("f-cap").value = "5,000"; $("f-copay").value = "10";
    state.terms.clauses = {
      room_rent: { ref: "Section 4.2", text: "Room rent is limited to Rs 5,000 per day", page: 7 },
      copay: { ref: "Section 6.1", text: "The insured bears 10% of every admissible claim", page: 9 },
    };
    renderCitations();
    $("lines").replaceChildren();
    [{ description: "Room, 3 days", category: "room", amount: 24000, days: 3 }, { description: "Doctor fees", category: "doctor_fees", amount: 20000 },
     { description: "Surgery", category: "surgery", amount: 50000 }, { description: "Pharmacy", category: "pharmacy", amount: 10000 },
     { description: "Gloves", category: "other", amount: 800 }, { description: "Gloves", category: "other", amount: 800 }].forEach((d) => addRow(d));
    refresh();
  };

  // ---------- start
  addRow(); addRow(); showOnly("empty"); collect(); warmUp();
})();
