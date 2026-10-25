// Fineprint client: posts the lease, reads the event stream, and marks up each clause as notes arrive.
"use strict";

const LABELS = { ask_about_this: "Ask about this", uncommon: "Unusual", standard: "Normal" };
const SEVERITY = { standard: 0, uncommon: 1, ask_about_this: 2 };
const ROLES = { juror_a: "First reviewer", juror_b: "Second reviewer", fast: "Summaries & fact-check", writer: "Writer" };
const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
// Share of the progress bar each stage fills.
const WEIGHT = { split: 5, classify: 15, retrieve: 10, jury: 60, verify: 10 };
const STAGE_TEXT = {
  split: "Reading your lease…",
  classify: "Sorting clauses into rent, deposit, repairs and the rest…",
  retrieve: "Pulling up the tenant guides for each clause…",
  jury: "Two reviewers are going through every clause…",
  verify: "Checking each note against the guide it cites…",
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Small element builder. Children may be strings, nodes, arrays or falsy; text is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === "") continue;
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
  controller: null,
  progress: { done: new Set(), current: null, reviews: 0, reviewTotal: 0 },
  models: { juror_a: document.body.dataset.jurorA, juror_b: document.body.dataset.jurorB },
};

/* ---------- Start view ---------- */

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
  if (text.length < 200) return showFormError("That looks too short to be a lease. Paste the whole thing, not just one section.");
  if (text.length > 60000) return showFormError("That's over 60,000 characters. Try pasting the main lease without the addenda.");
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
  $("#how").hidden = name !== "input";
  $("#view-results").hidden = name !== "results";
  window.scrollTo({ top: 0 });
}

/* ---------- Streaming ---------- */

async function analyze(text) {
  resetResults();
  showView("results");
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
      throw new Error(typeof detail.detail === "string" ? detail.detail : "Something went wrong on our end. Please try again.");
    }
    await readSSE(res.body, onEvent);
    if (!state.report) throw new Error("We lost the connection halfway through. Please try again.");
  } catch (err) {
    if (err.name === "AbortError") return;
    showView("input");
    showFormError(err.message);
  } finally {
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
      if (data) handle(type, JSON.parse(data)); // keep-alive comments carry no data
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
      state.progress.reviews += data.verdicts.length;
      updateProgress();
      updateCounts();
      if (state.selected == null) renderPanel();
      return;
    case "report":
      return applyReport(data);
    case "error":
      throw new Error(data.message);
  }
}

/** Same rule as the server, so the page fills in while the reviewers are still reading. */
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
      label: r.juror_a || r.juror_b ? r.label : "standard",
      confidence: r.confidence, question: r.question_to_ask, unverified: r.unverified,
    });
    updateClause(it);
  }
  // Show the model that actually answered (a fallback may have stepped in).
  for (const role of ["juror_a", "juror_b"]) {
    const call = report.calls.find((c) => c.role === role);
    if (call) state.models[role] = call.model;
  }
  updateCounts();
  writeVerdict(report);
  $("#progress").hidden = true;
  renderModelCard(report);
  renderPanel();
}

function writeVerdict(report) {
  const items = [...state.items.values()];
  const ask = items.filter((i) => i.label === "ask_about_this").length;
  const odd = items.filter((i) => i.label === "uncommon").length;
  const word = (n) => NUMBERS[n] ?? String(n);

  $("#kicker").textContent = "Your lease, marked up";
  const verdict = $("#verdict");
  verdict.replaceChildren(
    ask === 0
      ? "Nothing here needs a question."
      : [h("em", {}, word(ask)), ask === 1 ? " thing worth asking about." : " things worth asking about."],
  );
  $("#verdict-sub").textContent = [
    odd ? `${word(odd)} more ${odd === 1 ? "is" : "are"} a little unusual.` : "",
    "The rest reads like a normal student lease.",
  ].filter(Boolean).join(" ");

  $("#score").hidden = false;
  countUp($("#score-value"), report.clarity_score);

  const checked = $("#removed-badge");
  checked.textContent = report.unsupported_removed
    ? `We softened ${word(report.unsupported_removed).toLowerCase()} note${report.unsupported_removed > 1 ? "s" : ""} we couldn't back up with a source.`
    : "Every note was checked against its source.";
  checked.hidden = false;
}

/* ---------- Progress ---------- */

function setStage(name, status, detail) {
  const p = state.progress;
  if (status === "done") p.done.add(name);
  if (status === "start") p.current = name;
  if (name === "jury" && status === "start") p.reviewTotal = 2 * (parseInt(detail, 10) || 0);
  updateProgress();
}

function updateProgress() {
  const p = state.progress;
  let pct = [...p.done].reduce((s, n) => s + (WEIGHT[n] ?? 0), 0);
  if (p.current === "jury" && !p.done.has("jury") && p.reviewTotal) pct += WEIGHT.jury * Math.min(1, p.reviews / p.reviewTotal);
  $("#progress-fill").style.width = `${Math.max(3, pct)}%`;

  const stage = p.current && !p.done.has(p.current) ? p.current : "split";
  let text = STAGE_TEXT[stage];
  if (stage === "jury" && p.reviewTotal) text = `${text.slice(0, -1)} (${Math.min(p.reviews, p.reviewTotal)} of ${p.reviewTotal} reviews done)`;
  $("#progress-text").textContent = text;
}

/* ---------- Document ---------- */

function resetResults() {
  Object.assign(state, {
    items: new Map(), order: [], report: null, selected: null, filter: "all",
    progress: { done: new Set(), current: null, reviews: 0, reviewTotal: 0 },
  });
  $("#document").replaceChildren(h("p", { class: "page-loading" }, "Reading your lease…"));
  $("#kicker").textContent = "Reading your lease";
  $("#verdict").textContent = "Give us a moment…";
  $("#verdict-sub").textContent = "";
  $("#score").hidden = true;
  $("#progress").hidden = false;
  $("#removed-badge").hidden = true;
  $("#model-card").hidden = true;
  updateProgress();
  setFilter("all");
  updateCounts();
  $("#panel-body").replaceChildren();
}

function renderDocument() {
  $("#document").replaceChildren(...state.order.map((id) => clauseEl(state.items.get(id))));
}

function clauseEl(it) {
  const c = it.clause;
  return h("div", {
    class: "clause", role: "button", tabindex: "0", "aria-pressed": "false", id: `clause-${c.id}`, "data-id": c.id,
    onclick: () => select(c.id),
    onkeydown: (e) => onClauseKey(e, c.id),
  },
    h("div", { class: "clause-head" },
      h("span", { class: "clause-num" }, c.number ? `${c.number}.` : ""),
      h("h3", { class: "clause-title" }, h("span", {}, c.heading)),
      h("span", { class: "tag waiting" }, "reading…"),
    ),
    h("p", { class: "clause-summary" }),
    h("p", { class: "clause-text" }, stripHeading(c)),
  );
}

function stripHeading(c) {
  // The heading is shown separately. No /i flag: it must be ALL CAPS so we never eat the first sentence.
  return c.text.replace(/^\s*(?:(?:Section|SECTION|Article|ARTICLE)\s+)?[0-9IVXLC.]+[.):\-]?\s*[A-Z0-9 ,&'/\-]{3,60}[.:]\s*/, "");
}

function updateClause(it) {
  const el = $(`#clause-${it.clause.id}`);
  if (!el) return;
  el.className = `clause${it.label ? ` l-${it.label}` : ""}`;
  $(".clause-summary", el).textContent = it.cls?.summary ?? "";
  const tag = $(".tag", el);
  if (it.label) {
    tag.className = `tag ${it.label}`;
    tag.textContent = it.label === "standard" ? "normal" : LABELS[it.label].toLowerCase();
  }
  applyFilter(el, it);
  if (state.selected === it.clause.id) renderPanel();
}

function updateCounts() {
  const items = [...state.items.values()];
  $("#n-all").textContent = items.length;
  $("#n-ask").textContent = items.filter((i) => i.label === "ask_about_this").length;
  $("#n-uncommon").textContent = items.filter((i) => i.label === "uncommon").length;
}

$$(".filters .filter").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));

function setFilter(f) {
  state.filter = f;
  $$(".filters .filter").forEach((b) => {
    const on = b.dataset.filter === f;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", on);
  });
  state.items.forEach((it) => { const el = $(`#clause-${it.clause.id}`); if (el) applyFilter(el, it); });
}

function applyFilter(el, it) {
  el.classList.toggle("is-dim", state.filter !== "all" && it.label !== state.filter);
}

function countUp(out, target) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { out.textContent = target; return; }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / 900);
    out.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
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

/* ---------- Notes column ---------- */

function renderPanel() {
  const panel = $("#panel");
  const it = state.items.get(state.selected);
  panel.classList.toggle("is-open", !!it);
  panel.classList.toggle("is-summary", !it);
  const parts = (it ? clauseNotes(it) : questionList()).flat(Infinity).filter((p) => p instanceof Node);
  $("#panel-body").replaceChildren(...parts);
}

function questionList() {
  const flagged = [...state.items.values()]
    .filter((i) => i.question && i.label && i.label !== "standard")
    .sort((x, y) => SEVERITY[y.label] - SEVERITY[x.label]
      || (y.confidence === "high") - (x.confidence === "high")
      || x.clause.id - y.clause.id);

  if (!flagged.length) {
    return [
      h("h2", {}, "Before you sign, ask"),
      h("p", { class: "empty" }, state.report
        ? "Nothing jumped out. This lease looks like most student leases we compared it against."
        : "Questions will show up here as the reviewers find them."),
    ];
  }
  const text = flagged.map((i, n) => `${n + 1}. ${i.question}`).join("\n");
  return [
    h("h2", {}, "Before you sign, ask"),
    h("ol", { class: "questions" }, flagged.map((i) =>
      h("li", {}, h("button", { type: "button", onclick: () => { select(i.clause.id); $(`#clause-${i.clause.id}`).scrollIntoView({ block: "center", behavior: "smooth" }); } },
        i.question,
        h("small", {}, `${i.clause.number ? `§${i.clause.number} ` : ""}${i.clause.heading}`),
      )),
    )),
    h("button", { type: "button", class: "btn quiet", onclick: () => copy(text, "Copied. Paste it into an email to your landlord.") }, "Copy these questions"),
  ];
}

function clauseNotes(it) {
  const c = it.clause;
  const cited = new Set([...(it.a?.cite_ids ?? []), ...(it.b?.cite_ids ?? [])]);
  const sources = it.passages.filter((p) => cited.has(p.id));
  const reviewed = it.a || it.b;
  const agreement = { high: "both reviewers", maybe: "one of two reviewers", none: "" }[it.confidence];

  return [
    h("button", { type: "button", class: "btn quiet panel-close", onclick: () => select(null) }, "Close"),
    h("h2", {}, c.number ? `Section ${c.number}` : "Opening"),
    h("h3", {}, c.heading),
    it.label && h("p", { class: `note-label ${it.label}` }, LABELS[it.label], agreement && h("small", {}, `flagged by ${agreement}`)),
    it.cls?.summary && h("p", { class: "plain" }, it.cls.summary),
    it.unverified && h("p", { class: "unverified" }, "One reviewer's note didn't match its source, so we toned it down."),
    it.question && h("div", { class: "ask-card" },
      h("p", {}, `“${it.question}”`),
      h("button", { type: "button", class: "btn quiet", onclick: () => copy(it.question, "Copied.") }, "Copy question"),
    ),
    reviewed
      ? [reviewerNote("a", it.a, it.passages), reviewerNote("b", it.b, it.passages)]
      : h("p", { class: "empty" }, state.report ? "Nothing to review here: it's the title, signatures or standard wording." : "Still reading this one…"),
    sources.length > 0 && h("div", { class: "sources" },
      h("h2", {}, "From the guides"),
      sources.map((p) => h("blockquote", { class: "source" }, h("cite", {}, sourceLink(p)), clip(p.text, 340))),
    ),
  ];
}

function reviewerNote(j, v, passages) {
  const role = `juror_${j}`;
  const cites = (v?.cite_ids ?? []).map((id) => passages.find((p) => p.id === id)).filter(Boolean);
  return h("section", { class: "reviewer", "aria-label": ROLES[role] },
    h("div", { class: "reviewer-head" },
      h("span", {}, h("strong", {}, ROLES[role]), ` · ${state.models[role] ?? ""}`),
      v ? h("span", { class: `tag ${v.label}` }, LABELS[v.label].toLowerCase()) : h("span", { class: "tag waiting" }, state.report ? "no answer" : "reading…"),
    ),
    v && h("p", {}, v.explanation),
    cites.length > 0 && h("p", { class: "cites" }, `Cites: ${cites.map(sourceName).join(", ")}`),
  );
}

function sourceName(p) {
  if (/^https?:\/\//.test(p.source)) {
    try { return new URL(p.source).hostname.replace(/^www\./, ""); } catch { /* fall through */ }
  }
  return p.title ? `${p.title} (${p.source})` : p.source;
}

function sourceLink(p) {
  return /^https?:\/\//.test(p.source)
    ? h("a", { href: p.source, target: "_blank", rel: "noopener noreferrer" }, sourceName(p))
    : sourceName(p);
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ---------- Under the hood ---------- */

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
  $("#model-summary").textContent = `${models} open-weight models, ${report.calls.length} calls, ${tokens.toLocaleString()} tokens`;
  $("#model-rows").replaceChildren(...rows.map((g) => h("tr", {},
    h("td", {}, ROLES[g.role] ?? g.role),
    h("td", {}, h("code", {}, g.model)),
    h("td", {}, `${(g.ms / g.n / 1000).toFixed(1)}s avg × ${g.n}`),
    h("td", {}, `${g.inp.toLocaleString()} / ${g.out.toLocaleString()}`),
    h("td", {}, [g.fb && `${g.fb} fallback`, g.rep && `${g.rep} repaired`].filter(Boolean).join(", ") || "–"),
  )));
  $("#retrieval-src").textContent = report.retrieval_source === "local" ? "our bundled guide" : report.retrieval_source;
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
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}
