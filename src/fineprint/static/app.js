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

// ?demo=1 replays a recorded run of the sample lease (for flaky conference Wi-Fi).
const DEMO = new URLSearchParams(location.search).has("demo") ? "?demo=1" : "";

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
  email: newEmail(),
  models: { juror_a: document.body.dataset.jurorA, juror_b: document.body.dataset.jurorB },
};

/* ---------- Theme ---------- */

function applyTheme(choice) {
  if (choice === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try { choice === "auto" ? localStorage.removeItem("fineprint-theme") : localStorage.setItem("fineprint-theme", choice); } catch { /* private mode */ }
  $$("[data-theme-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === choice)));
}
$$("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeChoice)));
applyTheme(document.documentElement.dataset.theme ?? "auto");

/* ---------- Start view ---------- */

const form = $("#lease-form");
const textarea = $("#lease-text");
const formError = $("#form-error");

textarea.addEventListener("input", () => {
  $("#char-count").textContent = textarea.value.length.toLocaleString();
  formError.hidden = true;
});

// Drop a text file onto the paste box. PDFs need copy-paste for now.
textarea.addEventListener("dragover", (e) => { e.preventDefault(); textarea.classList.add("is-dragging"); });
textarea.addEventListener("dragleave", () => textarea.classList.remove("is-dragging"));
textarea.addEventListener("drop", async (e) => {
  e.preventDefault();
  textarea.classList.remove("is-dragging");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!/\.(txt|md|text)$/i.test(file.name) && !file.type.startsWith("text/")) {
    return showFormError("We can only read text files for now. Open the PDF, select all, copy, and paste it here.");
  }
  textarea.value = await file.text();
  textarea.dispatchEvent(new Event("input"));
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
    const res = await fetch(`/api/analyze${DEMO}`, {
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
      updateCounts();
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
  if (!flags.length) { Object.assign(it, { label: "standard", confidence: "none", question: null, highlight: null }); return; }
  flags.sort((x, y) => SEVERITY[y.label] - SEVERITY[x.label]);
  it.label = flags[0].label;
  it.confidence = flags.length === 2 ? "high" : "maybe";
  it.question = flags.find((v) => v.question_to_ask)?.question_to_ask ?? null;
  it.highlight = flags.find((v) => v.highlight)?.highlight ?? null;
}

function applyReport(report) {
  state.report = report;
  for (const r of report.clauses) {
    const it = state.items.get(r.clause.id);
    if (!it) continue;
    Object.assign(it, {
      cls: r.classification, passages: r.passages, a: r.juror_a, b: r.juror_b,
      label: r.juror_a || r.juror_b ? r.label : "standard",
      confidence: r.confidence, question: r.question_to_ask, highlight: r.highlight, unverified: r.unverified,
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
  $("#print-btn").hidden = false;
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
    ...(ask === 0
      ? ["Nothing here needs a question."]
      : [h("em", {}, word(ask)), ask === 1 ? " thing worth asking about." : " things worth asking about."]),
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
    email: newEmail(),
  });
  $("#document").replaceChildren(h("p", { class: "page-loading" }, "Reading your lease…"));
  $("#kicker").textContent = "Reading your lease";
  $("#verdict").textContent = "Give us a moment…";
  $("#verdict-sub").textContent = "";
  $("#score").hidden = true;
  $("#progress").hidden = false;
  $("#removed-badge").hidden = true;
  $("#print-btn").hidden = true;
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
    h("p", { class: "clause-note", hidden: true }),
  );
}

/** Wrap the first case- and spacing-insensitive match of `phrase` in a <mark>, like a highlighter would. */
function markPhrase(text, phrase, label) {
  if (!phrase) return [text];
  const words = phrase.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const m = new RegExp(words.join("\\s+"), "i").exec(text);
  if (!m) return [text];
  return [text.slice(0, m.index), h("mark", { class: `hl ${label}` }, m[0]), text.slice(m.index + m[0].length)];
}

function stripHeading(c) {
  // The heading is shown separately. No /i flag: it must be ALL CAPS so we never eat the first sentence.
  return c.text
    .replace(/^\s*(?:(?:Section|SECTION|Article|ARTICLE)\s+)?[0-9IVXLC.]+[.):\-]?\s*[A-Z0-9 ,&'/\-]{3,60}[.:]\s*/, "")
    .replace(/\n{2,}/g, "\n");
}

function updateClause(it) {
  const el = $(`#clause-${it.clause.id}`);
  if (!el) return;
  el.className = `clause${it.label ? ` l-${it.label}` : ""}`;
  $(".clause-summary", el).textContent = it.cls?.summary ?? "";
  $(".clause-text", el).replaceChildren(...markPhrase(stripHeading(it.clause), it.highlight, it.label).filter((n) => n !== ""));
  const note = $(".clause-note", el);
  const showNote = it.question && it.label && it.label !== "standard";
  note.hidden = !showNote;
  if (showNote) note.replaceChildren(h("span", { class: "note-lead" }, "Ask: "), it.question);
  const tag = $(".tag", el);
  if (it.label === "standard") {
    // Normal clauses get a quiet tick, like a reader who's checked them and moved on.
    tag.className = "tag standard";
    tag.textContent = "✓";
    tag.setAttribute("aria-label", "normal");
  } else if (it.label) {
    tag.className = `tag ${it.label}`;
    tag.textContent = LABELS[it.label].toLowerCase();
    tag.removeAttribute("aria-label");
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

$$(".filters .filter").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter, { jump: true })));
$("#sheet-backdrop").addEventListener("click", () => select(null));
$("#print-btn").addEventListener("click", () => window.print());
// The printout shows the question list, so print with nothing selected.
window.addEventListener("beforeprint", () => { if (state.selected != null) select(null); });

/** Filters show only the matching clauses; with `jump`, bring the first one into view. */
function setFilter(f, { jump = false } = {}) {
  state.filter = f;
  $$(".filters .filter").forEach((b) => {
    const on = b.dataset.filter === f;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", on);
  });
  state.items.forEach((it) => { const el = $(`#clause-${it.clause.id}`); if (el) applyFilter(el, it); });

  const doc = $("#document");
  const first = state.order.map((id) => $(`#clause-${id}`)).find((el) => el && !el.hidden);
  let empty = $(".filter-empty", doc);
  if (!first && f !== "all" && state.items.size) {
    empty ??= doc.appendChild(h("p", { class: "filter-empty empty" }));
    empty.textContent = f === "ask_about_this" ? "Nothing here needs a question." : "Nothing unusual in this lease.";
  } else empty?.remove();

  if (jump) {
    // Instant, not smooth: hiding clauses changes the page height mid-scroll. Landing on the filter bar
    // keeps the filters in view with the first match right under them.
    // ("instant" also overrides the page's CSS smooth scrolling.)
    window.scrollTo({ top: $(".toolbar").getBoundingClientRect().top + window.scrollY - 12, behavior: "instant" });
    if (first && f !== "all") first.focus({ preventScroll: true });
  }
}

function applyFilter(el, it) {
  el.hidden = state.filter !== "all" && it.label !== state.filter;
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
  const move = (d) => {
    e.preventDefault();
    // Skip clauses hidden by the current filter.
    for (let i = idx + d; i >= 0 && i < state.order.length; i += d) {
      const el = $(`#clause-${state.order[i]}`);
      if (el && !el.hidden) return el.focus();
    }
  };
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
  $("#sheet-backdrop").hidden = !it; // only visible on small screens, where notes open as a bottom sheet
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
    state.report && nextSteps(flagged),
    state.report && emailBlock(flagged),
    h("ol", { class: "questions" }, flagged.map((i) =>
      h("li", {}, h("button", { type: "button", onclick: () => { select(i.clause.id); $(`#clause-${i.clause.id}`).scrollIntoView({ block: "center", behavior: "smooth" }); } },
        i.question,
        h("small", {}, `${i.clause.number ? `§${i.clause.number} ` : ""}${i.clause.heading}`),
      )),
    )),
    flagged.length > 3 && h("button", {
      type: "button", class: "btn quiet show-all",
      onclick: (e) => { $(".questions").classList.add("is-expanded"); e.currentTarget.remove(); },
    }, `Show all ${flagged.length} questions`),
    h("button", { type: "button", class: "btn quiet", onclick: () => copy(text, "Copied.") }, "Copy these questions"),
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

/* ---------- Email to the landlord ---------- */

function newEmail() {
  return { open: false, tone: "friendly", draft: null, loading: false, error: null, seq: 0 };
}

/** The two things to do with the questions, kept at the top of the notes so they're never scrolled away. */
function nextSteps(flagged) {
  const e = state.email;
  return h("div", { class: "next-steps" },
    !e.open && h("button", { type: "button", class: "btn primary", onclick: () => { e.open = true; draftEmail(flagged); } }, "Write the email for me"),
    h("button", { type: "button", class: "btn secondary", onclick: () => openPractice(flagged) }, "Practice asking"),
    !e.open && h("p", { class: "hint" }, "Turn these questions into an email, or rehearse the conversation first."),
  );
}

function emailBlock(flagged) {
  const e = state.email;
  if (!e.open) return null;
  const tone = (t, label) => h("button", {
    type: "button", role: "radio", class: "tone-opt", "aria-checked": String(e.tone === t), disabled: e.loading,
    onclick: () => { if (e.tone !== t) { e.tone = t; draftEmail(flagged); } },
  }, label);

  return h("section", { class: "email", "aria-labelledby": "email-title" },
    h("div", { class: "email-head" },
      h("h2", { id: "email-title" }, "Your email"),
      h("div", { class: "tone", role: "radiogroup", "aria-label": "Tone" }, tone("friendly", "Friendly"), tone("firm", "Firm")),
    ),
    e.loading && h("p", { class: "empty" }, "Writing it…"),
    e.error && h("p", { class: "form-error" }, e.error),
    e.error && !e.loading && h("button", { type: "button", class: "btn secondary", onclick: () => draftEmail(flagged) }, "Try again"),
    e.draft && !e.loading && [
      h("label", { class: "field-label", for: "email-subject" }, "Subject"),
      h("input", { id: "email-subject", class: "email-subject", value: e.draft.subject, oninput: (ev) => (e.draft.subject = ev.target.value) }),
      h("label", { class: "field-label", for: "email-body" }, "Message"),
      h("textarea", { id: "email-body", class: "email-body", rows: "13", oninput: (ev) => (e.draft.body = ev.target.value) }, e.draft.body),
      h("p", { class: "hint" }, "Fill in the names in [brackets] before you send it."),
      h("div", { class: "email-actions" },
        h("button", { type: "button", class: "btn primary", onclick: () => copy(`Subject: ${e.draft.subject}\n\n${e.draft.body}`, "Email copied.") }, "Copy email"),
        h("a", { class: "btn quiet", href: `mailto:?subject=${encodeURIComponent(e.draft.subject)}&body=${encodeURIComponent(e.draft.body)}` }, "Open in my email app"),
      ),
    ],
  );
}

async function draftEmail(flagged) {
  const e = state.email;
  const seq = ++e.seq; // ignore answers to an older request if the tone changed mid-flight
  Object.assign(e, { loading: true, error: null });
  renderPanel();
  try {
    const res = await fetch(`/api/email${DEMO}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tone: e.tone,
        questions: flagged.slice(0, 15).map((i) => ({
          heading: i.clause.number ? `Section ${i.clause.number}, ${i.clause.heading}` : i.clause.heading,
          question: i.question,
        })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Couldn't write the email. Try again.");
    if (seq === e.seq) e.draft = data;
  } catch (err) {
    if (seq === e.seq) e.error = err.message;
  } finally {
    if (seq === e.seq) { e.loading = false; renderPanel(); }
  }
}

/* ---------- Practice the conversation ---------- */

const OPENING = "Hi! Thanks for coming by. Did you get a chance to read through the lease? Happy to answer any questions before you sign.";
const practice = { questions: [], history: [], covered: new Set(), notes: [], busy: false };
const dialog = $("#practice");

function openPractice(flagged) {
  Object.assign(practice, {
    questions: flagged.slice(0, 6).map((i) => i.question),
    history: [{ role: "landlord", text: OPENING }],
    covered: new Set(),
    notes: [],
    busy: false,
  });
  $("#chat-input").value = "";
  $("#chat-error").hidden = true;
  renderPractice();
  dialog.showModal();
  $("#chat-input").focus();
}

$("#practice-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); }); // click on backdrop

$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); }
});

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message || practice.busy) return;

  const history = practice.history.slice();
  practice.history.push({ role: "student", text: message });
  practice.busy = true;
  input.value = "";
  $("#chat-error").hidden = true;
  renderPractice();

  try {
    const res = await fetch("/api/practice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lease: leaseText(), questions: practice.questions, history, message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "The landlord didn't answer. Try again.");
    practice.history.push({ role: "landlord", text: data.landlord });
    if (data.coach) {
      practice.notes.push(data.coach);
      data.coach.covered.forEach((i) => practice.covered.add(i));
    }
  } catch (err) {
    practice.history.pop(); // put the message back so nothing is lost
    input.value = message;
    $("#chat-error").textContent = err.message;
    $("#chat-error").hidden = false;
  } finally {
    practice.busy = false;
    renderPractice();
    input.focus();
  }
});

$("#practice-finish").addEventListener("click", () => renderSummary());

function leaseText() {
  return state.order.map((id) => state.items.get(id).clause.text).join("\n\n").slice(0, 30000);
}

function renderPractice() {
  const log = $("#chat-log");
  log.replaceChildren(...[
    ...practice.history.map((m) => h("li", { class: `msg ${m.role}` },
      h("span", { class: "msg-who" }, m.role === "landlord" ? "Landlord" : "You"),
      h("p", {}, m.text),
    )),
    practice.busy && h("li", { class: "msg landlord typing" }, h("span", { class: "msg-who" }, "Landlord"), h("p", {}, "typing…")),
  ].filter(Boolean));
  log.scrollTop = log.scrollHeight;
  $("#chat-send").disabled = practice.busy;
  $("#chat-input").placeholder = practice.history.length > 1 ? "Ask a follow-up, or your next question…" : "Ask your first question…";

  $("#practice-checklist").replaceChildren(...practice.questions.map((q, i) =>
    h("li", { class: practice.covered.has(i) ? "done" : "" },
      h("span", { class: "sr-only" }, practice.covered.has(i) ? "Asked: " : "Not asked yet: "), q),
  ));

  const note = practice.notes.at(-1);
  $("#coach-note").replaceChildren(...(note ? [
    h("h3", {}, "Coach's note"),
    h("p", { class: "scores" }, `Clear ${note.clarity}/5 · Polite ${note.politeness}/5`),
    h("p", {}, note.tip),
    note.better && h("div", { class: "better" },
      h("p", {}, "Try: ", h("em", {}, `“${note.better}”`)),
      h("button", { type: "button", class: "btn quiet", onclick: () => { $("#chat-input").value = note.better; $("#chat-input").focus(); } }, "Use this wording"),
    ),
  ] : [h("p", { class: "empty" }, "Send a message and the coach will leave a note here.")]).filter((p) => p instanceof Node));
}

function renderSummary() {
  const asked = practice.covered.size;
  const total = practice.questions.length;
  const left = practice.questions.filter((_, i) => !practice.covered.has(i));
  const avg = (k) => practice.notes.length ? (practice.notes.reduce((s, n) => s + n[k], 0) / practice.notes.length).toFixed(1) : null;
  $("#coach-note").replaceChildren(...[
    h("h3", {}, "How it went"),
    h("p", { class: "summary-line" }, `You asked about ${asked} of ${total} question${total === 1 ? "" : "s"}.`),
    avg("clarity") && h("p", { class: "scores" }, `Average: clear ${avg("clarity")}/5 · polite ${avg("politeness")}/5`),
    left.length
      ? [h("p", {}, "Still worth asking:"), h("ul", { class: "left" }, left.map((q) => h("li", {}, q)))]
      : h("p", {}, "You covered everything. You're ready for the real conversation."),
  ].flat().filter((p) => p instanceof Node));
}

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
  $("#retrieval-src").textContent = {
    "local": "our bundled guide",
    "digitalocean-kb": "DigitalOcean Knowledge Base",
    "local (fallback)": "our bundled guide (the Knowledge Base didn't answer)",
  }[report.retrieval_source] ?? report.retrieval_source;
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
