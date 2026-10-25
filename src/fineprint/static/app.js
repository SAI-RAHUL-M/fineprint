// Fineprint client: posts the lease, reads the SSE stream, and renders clauses as verdicts arrive.
"use strict";

const LABELS = { ask_about_this: "Ask about this", uncommon: "Uncommon", standard: "Standard" };
const SEVERITY = { standard: 0, uncommon: 1, ask_about_this: 2 };
const ROLES = { juror_a: "Juror A", juror_b: "Juror B", fast: "Classifier / verifier", writer: "Writer" };
const STAGES = ["split", "classify", "retrieve", "jury", "verify"];
const RING = 2 * Math.PI * 52;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny element builder; children may be strings, nodes, arrays or falsy. Text is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const state = {
  items: new Map(), // clause id -> {clause, cls, passages, a, b, label, confidence, question, unverified}
  order: [],
  report: null,
  selected: null,
  filter: "all",
  running: false,
  controller: null,
  models: { juror_a: document.body.dataset.jurorA, juror_b: document.body.dataset.jurorB },
};

/* ---------- Input view ---------- */

const form = $("#lease-form");
const textarea = $("#lease-text");
const formError = $("#form-error");

textarea.addEventListener("input", () => {
  $("#char-count").textContent = textarea.value.length.toLocaleString();
  formError.hidden = true;
});

$("#sample-btn").addEventListener("click", async () => {
  const res = await fetch("/api/sample");
  textarea.value = await res.text();
  textarea.dispatchEvent(new Event("input"));
  form.requestSubmit();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textarea.value.trim();
  if (text.length < 200) return showFormError("Paste the full lease text (at least a few paragraphs).");
  if (text.length > 60000) return showFormError("That's longer than 60,000 characters. Try pasting the main lease without addenda.");
  analyze(text);
});

$("#new-btn").addEventListener("click", () => {
  state.controller?.abort();
  showView("input");
  textarea.focus();
});

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function showView(name) {
  $("#view-input").hidden = name !== "input";
  $("#view-results").hidden = name !== "results";
  window.scrollTo({ top: 0 });
}

/* ---------- Streaming ---------- */

async function analyze(text) {
  resetResults();
  showView("results");
  state.running = true;
  state.controller = new AbortController();
  $("#analyze-btn").disabled = true;

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: state.controller.signal,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(typeof detail.detail === "string" ? detail.detail : "The server couldn't analyze this lease.");
    }
    await readSSE(res.body, onEvent);
    if (!state.report) throw new Error("The analysis stopped early. Please try again.");
  } catch (err) {
    if (err.name === "AbortError") return;
    showView("input");
    showFormError(err.message);
  } finally {
    state.running = false;
    $("#analyze-btn").disabled = false;
  }
}

async function readSSE(body, handle) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, "\n");
    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let type = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) handle(type, JSON.parse(data));
    }
  }
}

function onEvent(type, data) {
  switch (type) {
    case "stage":
      return setStage(data.stage, data.status, data.detail);
    case "clauses":
      data.clauses.forEach((c) => {
        state.items.set(c.id, { clause: c, cls: null, passages: [], a: null, b: null, label: null, confidence: "none", question: null, unverified: false });
        state.order.push(c.id);
      });
      renderDocument();
      return renderPanel();
    case "classified":
      data.items.forEach((cls) => {
        const it = state.items.get(cls.clause_id);
        if (it) { it.cls = cls; updateClause(it); }
      });
      return;
    case "retrieved": {
      const it = state.items.get(data.clause_id);
      if (it) it.passages = data.passages;
      return;
    }
    case "verdicts":
      data.verdicts.forEach((v) => {
        const it = state.items.get(v.clause_id);
        if (!it) return;
        it[data.juror] = v;
        aggregate(it);
        updateClause(it);
      });
      updateCounts();
      if (state.selected == null) renderPanel();
      return;
    case "report":
      return applyReport(data);
    case "error":
      throw new Error(data.message);
  }
}

/** Same rule as the server, so the document lights up while the jury is still deliberating. */
function aggregate(it) {
  const flags = [it.a, it.b].filter((v) => v && v.label !== "standard");
  if (!it.a && !it.b) return;
  if (!flags.length) { it.label = "standard"; it.confidence = "none"; it.question = null; return; }
  it.label = flags.reduce((x, v) => (SEVERITY[v.label] > SEVERITY[x.label] ? v : x)).label;
  it.confidence = flags.length === 2 ? "high" : "maybe";
  it.question = flags.find((v) => v.question_to_ask)?.question_to_ask ?? null;
}

function applyReport(report) {
  state.report = report;
  for (const r of report.clauses) {
    const it = state.items.get(r.clause.id);
    if (!it) continue;
    Object.assign(it, {
      cls: r.classification, passages: r.passages, a: r.juror_a, b: r.juror_b,
      label: r.label, confidence: r.confidence, question: r.question_to_ask, unverified: r.unverified,
    });
    // Clauses the jury skipped (title, boilerplate) are shown as standard.
    if (!r.juror_a && !r.juror_b) it.label = "standard";
    updateClause(it);
  }
  // Show the model that actually answered (a fallback may have stepped in).
  for (const role of ["juror_a", "juror_b"]) {
    const call = report.calls.find((c) => c.role === role);
    if (call) state.models[role] = call.model;
  }
  updateCounts();
  setScore(report.clarity_score);
  const badge = $("#removed-badge");
  badge.textContent = report.unsupported_removed
    ? `${report.unsupported_removed} unsupported claim${report.unsupported_removed > 1 ? "s" : ""} removed`
    : "All flags backed by sources";
  badge.hidden = false;
  renderModelCard(report);
  renderPanel();
}

/* ---------- Results rendering ---------- */

function resetResults() {
  Object.assign(state, { items: new Map(), order: [], report: null, selected: null, filter: "all" });
  $("#document").replaceChildren(...Array.from({ length: 6 }, () => h("div", { class: "clause" }, h("div", { class: "skeleton", style: "width:40%" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton", style: "width:85%" }))));
  $$("#stages li").forEach((li) => { li.className = ""; $("small", li).textContent = ""; });
  $("#score-value").textContent = "–";
  const ring = $("#ring-fill");
  ring.style.strokeDashoffset = RING;
  ring.style.stroke = "";
  $("#removed-badge").hidden = true;
  $("#model-card").hidden = true;
  setFilter("all");
  updateCounts();
  $("#panel-body").replaceChildren();
}

function setStage(name, status, detail) {
  const li = $(`#stages li[data-stage="${name}"]`);
  if (!li) return;
  li.className = status === "start" ? "is-running" : status === "done" ? "is-done" : "";
  if (detail) $("small", li).textContent = detail;
  // A later stage starting implies earlier ones are done (split only reports "done").
  const idx = STAGES.indexOf(name);
  STAGES.slice(0, idx).forEach((s) => $(`#stages li[data-stage="${s}"]`).classList.replace("is-running", "is-done"));
}

function renderDocument() {
  $("#document").replaceChildren(...state.order.map((id) => clauseEl(state.items.get(id))));
}

function clauseEl(it) {
  const c = it.clause;
  const el = h("div", {
    class: "clause", role: "button", tabindex: "0", "aria-pressed": "false", id: `clause-${c.id}`, "data-id": c.id,
    onclick: () => select(c.id),
    onkeydown: (e) => onClauseKey(e, c.id),
  },
    h("div", { class: "clause-head" },
      h("span", { class: "clause-num" }, c.number ?? ""),
      h("h3", { class: "clause-title" }, c.heading),
      h("span", { class: "spacer" }),
      h("span", { class: "dots", title: "Juror A, Juror B" }, h("i", { "data-j": "a", class: "pending" }), h("i", { "data-j": "b", class: "pending" })),
      h("span", { class: "chip label", hidden: true }),
    ),
    h("p", { class: "clause-summary" }),
    h("p", { class: "clause-text" }, stripHeading(c)),
  );
  return el;
}

function stripHeading(c) {
  // The heading is shown separately; drop "5. CLEANING FEE." from the body text.
  // No /i flag: the heading must be ALL CAPS so we never eat the first sentence.
  return c.text.replace(/^\s*(?:(?:Section|SECTION|Article|ARTICLE)\s+)?[0-9IVXLC.]+[.):\-]?\s*[A-Z0-9 ,&'/\-]{3,60}[.:]\s*/, "");
}

function updateClause(it) {
  const el = $(`#clause-${it.clause.id}`);
  if (!el) return;
  el.className = `clause${it.label ? ` l-${it.label}` : ""}`;
  $(".clause-summary", el).textContent = it.cls?.summary ?? "";
  for (const j of ["a", "b"]) {
    const dot = $(`.dots i[data-j="${j}"]`, el);
    dot.className = it[j] ? it[j].label : state.report ? "" : "pending";
  }
  if (state.report && !it.a && !it.b) $(".dots", el).hidden = true;
  const chip = $(".chip.label", el);
  if (it.label && it.label !== "standard") {
    chip.className = `chip label ${it.label}`;
    chip.textContent = LABELS[it.label];
    chip.hidden = false;
  } else chip.hidden = true;
  applyFilter(el, it);
  if (state.selected === it.clause.id) renderPanel();
}

function updateCounts() {
  const items = [...state.items.values()];
  $("#n-all").textContent = items.length;
  $("#n-ask").textContent = items.filter((i) => i.label === "ask_about_this").length;
  $("#n-uncommon").textContent = items.filter((i) => i.label === "uncommon").length;
}

$$(".counts .count").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));

function setFilter(f) {
  state.filter = f;
  $$(".counts .count").forEach((b) => {
    const on = b.dataset.filter === f;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", on);
  });
  state.items.forEach((it) => { const el = $(`#clause-${it.clause.id}`); if (el) applyFilter(el, it); });
}

function applyFilter(el, it) {
  el.classList.toggle("is-dim", state.filter !== "all" && it.label !== state.filter);
}

function setScore(score) {
  const ring = $("#ring-fill");
  ring.style.stroke = score >= 80 ? "var(--standard)" : score >= 55 ? "var(--uncommon)" : "var(--ask)";
  ring.style.strokeDashoffset = RING * (1 - score / 100);
  const out = $("#score-value");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { out.textContent = score; return; }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / 1200);
    out.textContent = Math.round(score * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- Selection & keyboard ---------- */

function select(id) {
  state.selected = state.selected === id ? null : id;
  $$(".clause[aria-pressed]").forEach((el) => el.setAttribute("aria-pressed", String(Number(el.dataset.id) === state.selected)));
  renderPanel();
}

function onClauseKey(e, id) {
  const idx = state.order.indexOf(id);
  const move = (d) => { e.preventDefault(); $(`#clause-${state.order[idx + d]}`)?.focus(); };
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(id); }
  else if (e.key === "ArrowDown" || e.key === "j") move(1);
  else if (e.key === "ArrowUp" || e.key === "k") move(-1);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.selected != null) { const id = state.selected; select(null); $(`#clause-${id}`)?.focus(); }
});

/* ---------- Panel ---------- */

function renderPanel() {
  const panel = $("#panel");
  const it = state.items.get(state.selected);
  panel.classList.toggle("is-open", !!it);
  panel.classList.toggle("is-summary", !it);
  $("#panel-body").replaceChildren(...(it ? clausePanel(it) : summaryPanel()));
}

function summaryPanel() {
  const flagged = [...state.items.values()]
    .filter((i) => i.question && i.label && i.label !== "standard")
    .sort((x, y) => SEVERITY[y.label] - SEVERITY[x.label]
      || (y.confidence === "high") - (x.confidence === "high")
      || x.clause.id - y.clause.id);

  if (!flagged.length) {
    return [
      h("h2", {}, "Questions to ask your landlord"),
      state.report
        ? h("p", { class: "empty" }, "Nothing stood out. This lease looks standard compared with the tenant guides we checked.")
        : [h("p", { class: "empty" }, "Questions appear here as the jury deliberates."), h("div", { class: "skeleton" }), h("div", { class: "skeleton", style: "width:70%" })],
    ];
  }
  const text = flagged.map((i, n) => `${n + 1}. ${i.question}`).join("\n");
  return [
    h("h2", {}, "Questions to ask your landlord"),
    h("ol", { class: "questions" }, flagged.map((i) =>
      h("li", {}, h("button", { type: "button", onclick: () => { select(i.clause.id); $(`#clause-${i.clause.id}`).scrollIntoView({ block: "center", behavior: "smooth" }); } },
        i.question,
        h("small", {}, `${i.clause.heading} · ${LABELS[i.label]}${i.confidence === "high" ? " · both models agree" : ""}`),
      )),
    )),
    h("button", { type: "button", class: "btn ghost small", onclick: () => copy(text, "Questions copied") }, "Copy all questions"),
    h("p", { class: "help", style: "margin-top:12px" }, "Select any clause to see why it was flagged and its sources."),
  ];
}

function clausePanel(it) {
  const c = it.clause;
  const cited = new Set([...(it.a?.cite_ids ?? []), ...(it.b?.cite_ids ?? [])]);
  const sources = it.passages.filter((p) => cited.has(p.id));
  const juried = it.a || it.b;

  return [
    h("button", { type: "button", class: "btn ghost small panel-close", onclick: () => select(null), "aria-label": "Close details" }, "Close"),
    h("h2", {}, c.number ? `Section ${c.number}` : "Clause"),
    h("h3", {}, c.heading),
    h("div", { class: "meta" },
      it.label && h("span", { class: `chip ${it.label}` }, LABELS[it.label]),
      it.cls && h("span", { class: "chip type" }, it.cls.type.replace(/_/g, " ")),
      it.unverified && h("span", { class: "chip warn", title: "A model's cited source didn't support its explanation, so the citation was removed." }, "source not confirmed"),
    ),
    it.cls?.summary && h("p", {}, it.cls.summary),
    juried && agreement(it),
    it.question && h("div", { class: "ask-box" },
      h("h4", {}, "Ask your landlord"),
      h("p", {}, it.question),
      h("button", { type: "button", class: "btn ghost small", onclick: () => copy(it.question, "Question copied") }, "Copy question"),
    ),
    juried
      ? [jurorCard("a", it.a, it.passages), jurorCard("b", it.b, it.passages)]
      : h("p", { class: "empty" }, state.report ? "Not reviewed: this part has nothing to ask about (title, signatures or boilerplate)." : "The jury is reviewing this clause…"),
    sources.length > 0 && h("div", { class: "sources" },
      h("h2", {}, "Sources"),
      sources.map((p) => h("blockquote", { class: "source" },
        h("cite", {}, sourceLink(p)),
        clip(p.text, 360),
      )),
    ),
  ];
}

function agreement(it) {
  const [title, sub] =
    it.confidence === "high" ? ["Both models agree", "Two different model families flagged this independently."]
    : it.confidence === "maybe" ? ["One model flagged this", "Worth a quick question, but the models disagree."]
    : ["Both models say standard", "Nothing unusual compared with the guides."];
  return h("div", { class: "agree" },
    h("span", { class: "dots" }, h("i", { class: it.a?.label ?? "" }), h("i", { class: it.b?.label ?? "" })),
    h("span", {}, h("strong", {}, title), sub),
  );
}

function jurorCard(j, v, passages) {
  const role = `juror_${j}`;
  return h("section", { class: "juror", "aria-label": ROLES[role] },
    h("div", { class: "juror-head" },
      h("span", {}, h("b", {}, ROLES[role]), " · ", h("code", {}, state.models[role] ?? "")),
      v ? h("span", { class: `chip ${v.label}` }, LABELS[v.label]) : h("span", { class: "chip" }, state.report ? "no answer" : "thinking…"),
    ),
    v && h("p", {}, v.explanation),
    v?.cite_ids?.length > 0 && h("div", { class: "cites" },
      v.cite_ids.map((id) => {
        const p = passages.find((x) => x.id === id);
        return h("span", { class: "cite", title: p ? clip(p.text, 200) : id }, p ? sourceName(p) : id);
      }),
    ),
  );
}

function sourceName(p) {
  if (/^https?:\/\//.test(p.source)) {
    try { return new URL(p.source).hostname.replace(/^www\./, ""); } catch { /* fall through */ }
  }
  return p.title ? `${p.source} · ${p.title}` : p.source;
}

function sourceLink(p) {
  return /^https?:\/\//.test(p.source)
    ? h("a", { href: p.source, target: "_blank", rel: "noopener noreferrer" }, sourceName(p))
    : sourceName(p);
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ---------- Model card ---------- */

function renderModelCard(report) {
  const groups = new Map();
  for (const c of report.calls) {
    const key = `${c.role}|${c.model}`;
    const g = groups.get(key) ?? { role: c.role, model: c.model, n: 0, ms: 0, inp: 0, out: 0, fb: 0, rep: 0 };
    Object.assign(g, { n: g.n + 1, ms: g.ms + c.ms, inp: g.inp + c.input_tokens, out: g.out + c.output_tokens, fb: g.fb + c.used_fallback, rep: g.rep + c.repaired });
    groups.set(key, g);
  }
  const rows = [...groups.values()];
  const tokens = rows.reduce((s, g) => s + g.inp + g.out, 0);
  const models = new Set(rows.map((g) => g.model)).size;
  $("#model-summary").textContent = `${report.calls.length} calls · ${models} open-weight models · ${tokens.toLocaleString()} tokens`;
  $("#model-rows").replaceChildren(...rows.map((g) => h("tr", {},
    h("td", {}, ROLES[g.role] ?? g.role),
    h("td", {}, h("code", {}, g.model)),
    h("td", {}, `${(g.ms / g.n / 1000).toFixed(1)} s avg × ${g.n}`),
    h("td", {}, `${g.inp.toLocaleString()} / ${g.out.toLocaleString()}`),
    h("td", {}, [g.fb && `${g.fb} fallback`, g.rep && `${g.rep} repaired`].filter(Boolean).join(", ") || "–"),
  )));
  $("#retrieval-src").textContent = report.retrieval_source;
  $("#model-card").hidden = false;
}

/* ---------- Utilities ---------- */

let toastTimer;
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { toast("Couldn't copy. Select the text instead."); }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}
