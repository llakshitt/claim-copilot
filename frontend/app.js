(() => {
  const API = (window.CLAIM_API || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const CATEGORIES = [
    ["room", "Room"], ["doctor_fees", "Doctor fees"], ["surgery", "Surgery"], ["ot_charges", "OT charges"],
    ["nursing", "Nursing"], ["diagnostics", "Tests and scans"], ["procedure", "Procedure"],
    ["pharmacy", "Medicines"], ["consumables", "Consumables"], ["non_payable", "Not payable (known)"], ["other", "Other"],
  ];
  const state = { extra: { waiting: {}, exclusions: [], subLimits: {}, clauses: {} }, result: null };

  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const rs = (n) => "Rs " + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const num = (v) => (v === "" || v == null ? null : Number(String(v).replace(/,/g, "")));

  async function api(path, body) {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let data = {};
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(data.error || "Something went wrong. Try again in a moment.");
    return data;
  }

  // ---- navigation
  function go(id) {
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("is-on", p.id === id));
    document.querySelectorAll(".step").forEach((s) => s.classList.toggle("is-on", s.dataset.go === id));
    window.scrollTo({ top: 0 });
  }
  document.addEventListener("click", (e) => { const t = e.target.closest("[data-go]"); if (t) go(t.dataset.go); });

  // ---- bill lines
  function addLine(d = {}) {
    const sel = h("select", { "aria-label": "Category" });
    for (const [v, t] of CATEGORIES) sel.append(h("option", { value: v, text: t }));
    sel.value = d.category || "other";
    const desc = h("input", { placeholder: "Item as written on the bill", "aria-label": "Item", value: d.description || "" });
    const amt = h("input", { placeholder: "Amount (Rs)", inputmode: "decimal", "aria-label": "Amount", value: d.amount ?? "" });
    const days = h("input", { placeholder: "Days", inputmode: "numeric", "aria-label": "Days (for room)", value: d.days ?? "" });
    const rm = h("button", { class: "rm", type: "button", "aria-label": "Remove this line", text: "×" });
    const row = h("div", { class: "line" }, desc, h("div", { class: "pair" }, sel, amt, days, rm));
    rm.onclick = () => { row.remove(); total(); };
    row.addEventListener("input", total);
    $("lines").append(row);
    total();
  }
  function readLines() {
    return [...$("lines").children].map((row) => {
      const [desc, pair] = [row.querySelector("input"), row.querySelector(".pair")];
      const [sel, amt, days] = [pair.querySelector("select"), ...pair.querySelectorAll("input")];
      const line = { description: desc.value.trim() || "Item", category: sel.value, amount: num(amt.value) };
      if (num(days.value)) line.days = num(days.value);
      return line;
    }).filter((l) => l.amount);
  }
  function total() {
    const sum = readLines().reduce((a, l) => a + l.amount, 0);
    $("bill-total").textContent = sum ? "Bill total: " + rs(sum) : "";
  }
  $("add-line").onclick = () => addLine();

  // ---- policy
  function policyBody() {
    const p = { sum_insured: num($("f-si").value) };
    if (num($("f-cap").value)) p.room_rent_cap_per_day = num($("f-cap").value);
    if (num($("f-pct").value)) p.room_rent_cap_pct_of_si = num($("f-pct").value);
    if (num($("f-copay").value)) p.copay_pct = num($("f-copay").value);
    if (num($("f-ded").value)) p.deductible = num($("f-ded").value);
    if (Object.keys(state.extra.subLimits).length) p.sub_limits = state.extra.subLimits;
    if (Object.keys(state.extra.waiting).length) p.waiting_period_days = state.extra.waiting;
    if (state.extra.exclusions.length) p.exclusions = state.extra.exclusions;
    p.clauses = state.extra.clauses;
    return p;
  }

  $("read-policy").onclick = async () => {
    const text = $("policy-text").value.trim();
    const st = $("read-status");
    if (!text) { st.textContent = "Paste some policy text first."; st.className = "status err"; return; }
    $("read-policy").disabled = true; st.className = "status"; st.textContent = "Reading your policy. The first request can take up to a minute.";
    try {
      const d = await api("/api/extract", { text });
      const box = $("citations"); box.replaceChildren(); box.hidden = false;
      if (!d.policy) {
        st.textContent = "We could not find the sum insured in that text. Type the numbers yourself below.";
        st.className = "status err";
      } else {
        const p = d.policy;
        $("f-si").value = p.sum_insured; $("f-cap").value = p.room_rent_cap_per_day || "";
        $("f-pct").value = p.room_rent_cap_pct_of_si || ""; $("f-copay").value = Number(p.copay_pct) || "";
        $("f-ded").value = Number(p.deductible) || "";
        state.extra = { waiting: p.waiting_period_days || {}, exclusions: p.exclusions || [], subLimits: p.sub_limits || {}, clauses: p.clauses || {} };
        st.textContent = "Done. Check the numbers below against your policy.";
        for (const c of Object.values(p.clauses)) {
          box.append(h("p", {}, h("strong", { text: c.ref + (c.page ? ", page " + c.page : "") + ": " }), h("q", { text: c.text })));
        }
      }
      for (const [f, why] of d.rejected || []) {
        $("citations").hidden = false;
        $("citations").append(h("p", { class: "skipped", text: "Skipped " + f.replace(/_/g, " ") + " because " + why + "." }));
      }
    } catch (e) { st.textContent = e.message; st.className = "status err"; }
    $("read-policy").disabled = false;
  };

  // ---- check the bill
  $("calc").onclick = async () => {
    const st = $("calc-status");
    const lines = readLines();
    if (!num($("f-si").value)) { st.textContent = "Add the sum insured on the Policy step."; st.className = "status err"; return; }
    if (!lines.length) { st.textContent = "Add at least one bill line with an amount."; st.className = "status err"; return; }
    $("calc").disabled = true; st.className = "status"; st.textContent = "Checking. The first request can take up to a minute.";
    const claim = { lines, condition: $("f-cond").value.trim() || null };
    if (num($("f-age").value) != null) claim.days_since_policy_start = num($("f-age").value);
    try {
      const [est, aud] = await Promise.all([
        api("/api/estimate", { policy: policyBody(), claim }),
        api("/api/audit", { claim: { lines }, procedure: $("f-proc").value.trim() || null }),
      ]);
      state.result = est; showResult(est, aud.findings); st.textContent = ""; go("result");
    } catch (e) { st.textContent = e.message; st.className = "status err"; }
    $("calc").disabled = false;
  };

  function showResult(est, findings) {
    $("result-empty").hidden = true;
    const r = $("receipt"); r.replaceChildren(); r.hidden = false;
    const row = (cls, what, amt) => h("div", { class: "r-row " + cls }, h("span", { class: "what", text: what }), h("span", { class: "amt", text: amt }));
    r.append(row("", "Hospital bill", rs(est.total_billed)));
    for (const s of est.steps) {
      r.append(row("r-cut", s.explanation, "− " + rs(Math.abs(Number(s.effect)))));
      if (s.clause) r.append(h("p", { class: "r-cite", text: s.clause.ref + (s.clause.page ? ", page " + s.clause.page : "") + ": “" + s.clause.text + "”" }));
    }
    r.append(row("r-sum pay", "Insurer pays about", rs(est.payable)));
    r.append(row("r-sum you", "You pay about", rs(est.patient_pays)));
    for (const w of est.warnings) r.append(h("p", { class: "r-warn", text: w }));
    const list = $("findings-list"); list.replaceChildren();
    for (const f of findings) list.append(h("li", { text: f.detail }));
    $("findings").hidden = findings.length === 0;
    $("to-letter").hidden = false;
    const cut = est.steps.map((s) => s.explanation).join(" ");
    if (!$("g-reason").value) $("g-reason").value = cut;
    if (!$("g-amt").value && Number(est.patient_pays) > 0) $("g-amt").value = est.patient_pays;
  }

  // ---- letter
  $("draft").onclick = async () => {
    const st = $("g-status"); st.className = "status"; st.textContent = "Writing.";
    const body = { level: $("g-level").value, reason: $("g-reason").value.trim() };
    const map = { name: "g-name", insurer: "g-insurer", policy_no: "g-policy", claim_no: "g-claim", disputed_amount: "g-amt" };
    for (const [k, id] of Object.entries(map)) if ($(id).value.trim()) body[k] = $(id).value.trim();
    const first = state.result && state.result.steps.find((s) => s.clause);
    if (first) { body.clause_ref = first.clause.ref; body.clause_text = first.clause.text; }
    try {
      const d = await api("/api/grievance", body);
      $("letter-out").textContent = d.letter; $("letter-out").hidden = false; $("copy").hidden = false; st.textContent = "";
    } catch (e) { st.textContent = e.message; st.className = "status err"; }
  };
  $("copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("letter-out").textContent); $("g-status").textContent = "Copied."; }
    catch (_) { $("g-status").textContent = "Copy failed. Select the text and copy it."; }
  };

  // ---- sample
  $("sample").onclick = () => {
    $("f-si").value = 500000; $("f-cap").value = 5000; $("f-copay").value = 10;
    state.extra.clauses = {
      room_rent: { ref: "Section 4.2", text: "Room rent is limited to Rs 5,000 per day", page: 7 },
      copay: { ref: "Section 6.1", text: "The insured bears 10% of every admissible claim", page: 9 },
    };
    $("lines").replaceChildren();
    [{ description: "Room, 3 days", category: "room", amount: 24000, days: 3 },
     { description: "Doctor fees", category: "doctor_fees", amount: 20000 },
     { description: "Surgery", category: "surgery", amount: 50000 },
     { description: "Pharmacy", category: "pharmacy", amount: 10000 },
     { description: "Gloves", category: "other", amount: 800 }, { description: "Gloves", category: "other", amount: 800 },
    ].forEach(addLine);
    go("bill");
  };

  addLine(); addLine();
})();
