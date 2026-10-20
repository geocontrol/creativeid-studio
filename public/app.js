// CreativeID Studio — persona editor (M5).
// Talks only to the local API (/api/personas…). No framework, no build step.

// ------------------------------------------------------------------ constants

const LIMITS = { name: 300, bio: 2000 };

const RELATIONSHIPS = [
  ["performed", "performed at or with"],
  ["exhibited", "exhibited at or with"],
  ["curated", "curated"],
  ["collaborated_on", "collaborated on"],
  ["created", "made"],
  ["released", "released with"],
  ["represented_by", "am represented by"],
  ["member_of", "am a member of"],
  ["references", "refer to"],
  ["attests_to", "vouch for"],
];
const REL_LABEL = Object.fromEntries(RELATIONSHIPS);

const ID_SCHEMES = [
  "isni", "orcid", "wikidata", "musicbrainz", "discogs", "viaf", "ipi", "ipn",
  "auracle", "isrc", "iswc", "isan", "doi", "isbn", "olid", "tmdb", "rsl", "linkedArt", "accession",
];

// Wizard field groups that suggest private details, when marked anything but public.
const PRIVATE_SUGGESTIONS = {
  booking: ["Booking contact"],
  commercial: ["Fees and technical needs"],
  rights: ["Legal name", "Registration numbers"],
  payment: ["Payment details"],
  drafts: ["Work in progress"],
};
const DEFAULT_SUGGESTIONS = ["Legal name", "Booking contact"];

const LAST_PERSONA_KEY = "creativeid.lastPersona";
const WIZARD_KEY = "creativeid.storageGuide.v1";

// ------------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);

/** Builds an element; children may be strings or nodes. Never parses HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const segmenter = Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const graphemes = (s) => (segmenter ? [...segmenter.segment(s)].length : [...s].length);

const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

function safeStorage(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.issues = body?.issues || [];
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Turns API validation issues into one readable sentence. */
function describeIssues(err) {
  if (!err.issues?.length) return err.message;
  return err.issues.map((i) => `${humanPath(i.path)}: ${i.message}`).join(" ");
}

function humanPath(path) {
  return path
    .replace(/^(profile|work|connection)\./, "")
    .replace(/\[(\d+)\]/g, (_, n) => ` ${Number(n) + 1}`)
    .replace(/\./g, " ")
    .replace(/externalIds/, "identifier")
    .replace(/referenceUrl/, "link")
    .replace(/^\w/, (c) => c.toUpperCase());
}

// ------------------------------------------------------------------ state

const state = {
  personas: [],
  id: null,
  persona: null,
  previews: null,
  inspector: "atproto",
  editingWork: null, // work id, or "new"
  editingConn: null,
  resolved: null, // result of the last connection lookup
};

// ------------------------------------------------------------------ chips (disciplines, tags)

function makeChips(rootId, onChange) {
  const root = $(rootId);
  const list = root.querySelector(".chip-list");
  const input = root.querySelector("input");
  const max = Number(root.dataset.max);
  const maxLen = Number(root.dataset.maxlen);
  let values = [];

  const render = () => {
    list.replaceChildren(
      ...values.map((v, i) =>
        h("li", { class: "tag-chip" }, v,
          h("button", { type: "button", "aria-label": `Remove ${v}`, onclick: () => { values.splice(i, 1); render(); onChange?.(); input.focus(); } }, "×"))
      )
    );
    input.disabled = values.length >= max;
    input.placeholder = values.length >= max ? `That's the maximum of ${max}` : "Type one and press Enter";
  };

  const add = () => {
    const v = input.value.trim().replace(/,$/, "").trim();
    if (!v) return;
    if (graphemes(v) > maxLen) {
      input.setCustomValidity(`Keep each one under ${maxLen} characters.`);
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    if (!values.includes(v) && values.length < max) values.push(v);
    input.value = "";
    render();
    onChange?.();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && !input.value && values.length) {
      values.pop();
      render();
      onChange?.();
    }
  });
  input.addEventListener("blur", add);

  return {
    get: () => {
      add();
      return [...values];
    },
    set: (v) => {
      values = [...(v || [])];
      input.value = "";
      render();
    },
  };
}

// ------------------------------------------------------------------ repeatable rows

const ROW_KINDS = {
  link: {
    cls: "row-link",
    fields: [
      { key: "uri", label: "Address", type: "url", placeholder: "https://…" },
      { key: "title", label: "Label", placeholder: "Website" },
    ],
  },
  id: {
    cls: "row-id",
    fields: [
      { key: "scheme", label: "Scheme", options: ID_SCHEMES },
      { key: "id", label: "Identifier", placeholder: "0000 0001 2345 6789" },
      { key: "uri", label: "Link (optional)", type: "url", placeholder: "https://…" },
    ],
  },
  credit: {
    cls: "row-credit",
    fields: [
      { key: "name", label: "Name", placeholder: "Name" },
      { key: "role", label: "Role", placeholder: "Role" },
      { key: "did", label: "DID (optional)", placeholder: "did:plc:…" },
    ],
  },
};

function makeRows(fieldsetId, kind, max, onChange) {
  const fs = $(fieldsetId);
  const rows = fs.querySelector(".rows");
  const addBtn = fs.querySelector(".add-row");
  const spec = ROW_KINDS[kind];

  const addRow = (value = {}) => {
    const row = h("div", { class: `row ${spec.cls}` });
    for (const f of spec.fields) {
      let control;
      if (f.options) {
        control = h("select", { "aria-label": f.label, "data-key": f.key },
          ...f.options.map((o) => h("option", { value: o, selected: o === value[f.key] }, o)));
        if (value[f.key] && !f.options.includes(value[f.key])) {
          control.prepend(h("option", { value: value[f.key], selected: true }, value[f.key]));
        }
      } else {
        control = h("input", {
          type: f.type || "text",
          "aria-label": f.label,
          placeholder: f.placeholder,
          "data-key": f.key,
          autocomplete: "off",
        });
        control.value = value[f.key] || "";
      }
      control.addEventListener("input", () => onChange?.());
      row.append(control);
    }
    row.append(h("button", {
      type: "button",
      class: "btn btn-quiet btn-small remove",
      onclick: () => { row.remove(); sync(); onChange?.(); },
    }, "Remove"));
    rows.append(row);
    sync();
    return row;
  };

  const sync = () => {
    addBtn.disabled = rows.children.length >= max;
  };

  addBtn.addEventListener("click", () => addRow().querySelector("input, select")?.focus());

  return {
    get: () =>
      [...rows.children]
        .map((row) => Object.fromEntries([...row.querySelectorAll("[data-key]")].map((c) => [c.dataset.key, c.value.trim()])))
        .filter((v) => Object.entries(v).some(([k, x]) => k !== "scheme" && x))
        .map((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x))),
    set: (list) => {
      rows.replaceChildren();
      (list || []).forEach((v) => addRow(v));
      sync();
    },
  };
}

// ------------------------------------------------------------------ tabs (roving tabindex)

function makeTabs(tabs, onSelect) {
  const select = (tab, focus = false) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    if (focus) tab.focus();
    onSelect(tab);
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const next = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (next) {
        e.preventDefault();
        select(tabs[(i + next + tabs.length) % tabs.length], true);
      } else if (e.key === "Home") select(tabs[0], true);
      else if (e.key === "End") select(tabs[tabs.length - 1], true);
    });
  });
  return select;
}

const sectionTabs = [...document.querySelectorAll(".section-tab")];
const selectSection = makeTabs(sectionTabs, (tab) => {
  for (const t of sectionTabs) $(t.getAttribute("aria-controls")).hidden = t !== tab;
  if (tab.id === "tab-publish") refreshPlan();
  if (tab.id === "tab-private") renderPrivateSuggestions();
});

const inspectorTabs = [...document.querySelectorAll(".inspector-tab")];
makeTabs(inspectorTabs, (tab) => {
  state.inspector = tab.dataset.format;
  renderInspector();
});

// ------------------------------------------------------------------ loading

async function loadPersonas(selectId) {
  const { personas } = await api("GET", "/api/personas");
  state.personas = personas;
  if (!personas.length) {
    state.id = null;
    showWelcome(true);
    return;
  }
  const remembered = safeStorage(() => localStorage.getItem(LAST_PERSONA_KEY), null);
  const id = [selectId, state.id, remembered].find((x) => x && personas.some((p) => p.personaId === x)) || personas[0].personaId;
  await openPersona(id);
}

async function openPersona(id) {
  const data = await api("GET", `/api/personas/${encodeURIComponent(id)}`);
  state.id = id;
  state.persona = data.persona;
  state.previews = data.previews;
  safeStorage(() => localStorage.setItem(LAST_PERSONA_KEY, id));
  showStudio();
  renderAll();
}

/** Applies a persona returned by any write, and refreshes previews. */
async function applyPersona(persona) {
  state.persona = persona;
  const summary = state.personas.find((p) => p.personaId === persona.personaId);
  if (summary) summary.name = persona.profile.name;
  const { previews } = await api("GET", `/api/personas/${encodeURIComponent(persona.personaId)}/preview`);
  state.previews = previews;
  renderAll();
}

// ------------------------------------------------------------------ welcome

function showWelcome(first) {
  $("welcome").hidden = false;
  $("studio").hidden = true;
  $("switcher").hidden = first;
  $("welcome-title").textContent = first ? "Make your first persona" : "Make another persona";
  $("welcome-cancel").hidden = first;
  $("local-status").textContent = first ? "Nothing saved yet. Everything you make stays on this computer." : $("local-status").textContent;
  $("welcome-name").value = "";
  $("welcome-error").textContent = "";
  $("welcome-name").focus();
}

function showStudio() {
  $("welcome").hidden = true;
  $("studio").hidden = false;
  $("switcher").hidden = false;
}

$("welcome-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("welcome-name").value.trim();
  if (!name) {
    $("welcome-error").textContent = "Add a name to create a persona.";
    $("welcome-name").setAttribute("aria-invalid", "true");
    return;
  }
  $("welcome-name").removeAttribute("aria-invalid");
  try {
    const { persona } = await api("POST", "/api/personas", { name });
    await loadPersonas(persona.personaId);
    selectSection(sectionTabs[0]);
    $("p-bio").focus();
  } catch (err) {
    $("welcome-error").textContent = describeIssues(err);
  }
});

$("welcome-cancel").addEventListener("click", () => openPersona(state.id));
$("new-persona-btn").addEventListener("click", () => showWelcome(false));
$("persona-select").addEventListener("change", (e) => openPersona(e.target.value));

// ------------------------------------------------------------------ rendering

function renderAll() {
  renderSwitcher();
  renderLocalStatus();
  fillProfileForm();
  renderWorks();
  renderConnections();
  renderPrivate();
  renderPublishStates();
  renderLabel();
  renderInspector();
  $("works-count").textContent = state.persona.works.length || "";
  $("connections-count").textContent = state.persona.connections.length || "";
}

function renderSwitcher() {
  $("persona-select").replaceChildren(
    ...state.personas.map((p) => h("option", { value: p.personaId, selected: p.personaId === state.id }, p.name))
  );
}

function renderLocalStatus() {
  const path = state.persona.filePath;
  const short = path.split(/[\\/]/).slice(-3).join("/");
  const el = $("local-status");
  el.replaceChildren("Saved on this computer in ", h("code", { title: path }, short));
}

// --- profile --------------------------------------------------------------

const disciplines = makeChips("p-disciplines", () => profileChanged());
const links = makeRows("p-links", "link", 8, () => profileChanged());
const ids = makeRows("p-ids", "id", 20, () => profileChanged());

function fillProfileForm() {
  const p = state.persona.profile;
  $("p-name").value = p.name;
  $("p-bio").value = p.bio || "";
  $("p-based").value = p.based?.name || "";
  disciplines.set(p.disciplines);
  links.set(p.links);
  ids.set(p.externalIds);
  updateCounters();
  setStatus($("profile-status"), "");
}

function readProfileForm() {
  const based = $("p-based").value.trim();
  const keepDid = state.persona?.profile.based?.did;
  return {
    name: $("p-name").value,
    bio: $("p-bio").value,
    disciplines: disciplines.get(),
    based: based || keepDid ? { ...(based ? { name: based } : {}), ...(keepDid ? { did: keepDid } : {}) } : undefined,
    links: links.get(),
    externalIds: ids.get(),
  };
}

function updateCounters() {
  for (const [field, limit] of [["name", LIMITS.name], ["bio", LIMITS.bio]]) {
    const n = graphemes($(`p-${field}`).value.trim());
    const counter = $(`p-${field}-count`);
    counter.textContent = n > limit * 0.8 ? `${n} / ${limit}` : "";
    counter.classList.toggle("over", n > limit);
  }
}

function profileChanged() {
  updateCounters();
  setStatus($("profile-status"), "Unsaved changes", "warn");
  renderLabel();
}

for (const id of ["p-name", "p-bio", "p-based"]) $(id).addEventListener("input", profileChanged);

$("profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("p-name").removeAttribute("aria-invalid");
  try {
    const { persona } = await api("PUT", `/api/personas/${encodeURIComponent(state.id)}`, readProfileForm());
    await applyPersona(persona);
    setStatus($("profile-status"), "Saved", "ok");
  } catch (err) {
    if (err.issues.some((i) => i.path === "profile.name")) $("p-name").setAttribute("aria-invalid", "true");
    setStatus($("profile-status"), describeIssues(err), "err");
  }
});

// --- trash ------------------------------------------------------------------

$("trash-btn").addEventListener("click", () => {
  $("trash-confirm").hidden = false;
  $("trash-btn").hidden = true;
  $("trash-no").focus();
});
$("trash-no").addEventListener("click", () => {
  $("trash-confirm").hidden = true;
  $("trash-btn").hidden = false;
  $("trash-btn").focus();
});
$("trash-yes").addEventListener("click", async () => {
  await api("DELETE", `/api/personas/${encodeURIComponent(state.id)}`);
  $("trash-confirm").hidden = true;
  $("trash-btn").hidden = false;
  state.id = null;
  safeStorage(() => localStorage.removeItem(LAST_PERSONA_KEY));
  await loadPersonas();
});

// --- works ------------------------------------------------------------------

const credits = makeRows("w-credits", "credit", 20);
const tags = makeChips("w-tags");

function renderWorks() {
  const works = state.persona.works;
  $("works-empty").hidden = works.length > 0;
  $("works-list").replaceChildren(
    ...works.map((w) => {
      const meta = [w.completionDate, w.credits?.length ? creditsText(w.credits) : null].filter(Boolean).join(". ");
      return h("li", { class: "item" },
        h("div", {},
          h("p", { class: "item-title" }, h("span", { class: "work-title" }, w.title)),
          meta ? h("p", { class: "item-meta" }, meta) : null,
          w.tags?.length ? h("p", { class: "item-meta" }, w.tags.join(", ")) : null),
        h("div", { class: "item-actions" },
          h("button", { type: "button", class: "btn-link", onclick: () => openWorkForm(w) }, "Edit"),
          removeButton(`Remove ${w.title}`, "Removed works are also removed from AT Protocol the next time you publish.",
            async () => applyPersona((await api("DELETE", `/api/personas/${encodeURIComponent(state.id)}/works/${w.id}`)).persona))));
    })
  );
}

const creditsText = (list) => list.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join(", ");

/** Credits other than the persona itself, for the wall label. */
const otherCredits = (list) => (list || []).filter((c) => c.name !== state.persona.profile.name || c.role);

/** A remove link that asks once before acting. */
function removeButton(label, note, action) {
  const btn = h("button", { type: "button", class: "btn-link", "aria-label": label }, "Remove");
  btn.addEventListener("click", async () => {
    if (btn.dataset.armed) {
      await action();
      return;
    }
    btn.dataset.armed = "1";
    btn.textContent = "Confirm remove";
    btn.title = note;
    setTimeout(() => {
      if (btn.isConnected) {
        delete btn.dataset.armed;
        btn.textContent = "Remove";
      }
    }, 5000);
  });
  return btn;
}

function openWorkForm(work) {
  state.editingWork = work ? work.id : "new";
  $("work-form-title").textContent = work ? "Edit work" : "New work";
  $("w-title").value = work?.title || "";
  $("w-date").value = work?.completionDate || "";
  $("w-url").value = work?.referenceUrl || "";
  $("w-desc").value = work?.description || "";
  credits.set(work?.credits || (work ? [] : [{ name: state.persona.profile.name }]));
  tags.set(work?.tags);
  setStatus($("work-status"), "");
  $("work-form").hidden = false;
  $("add-work-btn").hidden = true;
  $("w-title").focus();
}

function closeWorkForm() {
  state.editingWork = null;
  $("work-form").hidden = true;
  $("add-work-btn").hidden = false;
  $("add-work-btn").focus();
}

$("add-work-btn").addEventListener("click", () => openWorkForm(null));
$("work-cancel").addEventListener("click", closeWorkForm);

$("work-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = {
    title: $("w-title").value,
    completionDate: $("w-date").value,
    referenceUrl: $("w-url").value,
    description: $("w-desc").value,
    credits: credits.get().filter((c) => c.name || c.did),
    tags: tags.get(),
  };
  try {
    const base = `/api/personas/${encodeURIComponent(state.id)}/works`;
    const { persona } = state.editingWork === "new"
      ? await api("POST", base, input)
      : await api("PUT", `${base}/${state.editingWork}`, input);
    closeWorkForm();
    await applyPersona(persona);
  } catch (err) {
    setStatus($("work-status"), describeIssues(err), "err");
  }
});

// --- connections ------------------------------------------------------------

$("c-rel").replaceChildren(
  ...RELATIONSHIPS.map(([v, label]) => h("option", { value: v }, label)),
  h("option", { value: "__other" }, "something else…")
);
$("c-rel").addEventListener("change", () => {
  $("c-rel-other-field").hidden = $("c-rel").value !== "__other";
});

function targetText(c) {
  const s = c.subject;
  if (s.did) return s.name || s.did;
  return s.uri;
}

function renderConnections() {
  const conns = state.persona.connections;
  $("conns-empty").hidden = conns.length > 0;
  $("conns-list").replaceChildren(
    ...conns.map((c) => {
      const verb = REL_LABEL[c.relationship] || c.relationship;
      const unpinned = c.subject.uri && !c.subject.cid;
      return h("li", { class: "item" },
        h("div", {},
          h("p", { class: "item-title" }, `I ${verb} `, h("strong", {}, targetText(c))),
          h("p", { class: "item-meta" }, [c.role, c.note].filter(Boolean).join(". ") || (c.subject.did && c.subject.name ? c.subject.did : "")),
          unpinned ? h("p", { class: "item-warning" }, "Not pinned to a version: look it up again to pin it.") : null),
        h("div", { class: "item-actions" },
          h("button", { type: "button", class: "btn-link", onclick: () => openConnForm(c) }, "Edit"),
          removeButton(`Remove connection to ${targetText(c)}`, "Removed connections are also removed from AT Protocol the next time you publish.",
            async () => applyPersona((await api("DELETE", `/api/personas/${encodeURIComponent(state.id)}/connections/${c.id}`)).persona))));
    })
  );
}

function openConnForm(conn) {
  state.editingConn = conn ? conn.id : "new";
  state.resolved = null;
  $("conn-form-title").textContent = conn ? "Edit connection" : "New connection";
  const known = conn && REL_LABEL[conn.relationship];
  $("c-rel").value = conn ? (known ? conn.relationship : "__other") : "performed";
  $("c-rel-other").value = conn && !known ? conn.relationship : "";
  $("c-rel-other-field").hidden = $("c-rel").value !== "__other";
  $("c-target").value = conn ? conn.subject.did || conn.subject.uri : "";
  $("c-name").value = conn?.subject.name || "";
  $("c-role").value = conn?.role || "";
  $("c-note").value = conn?.note || "";
  if (conn?.subject.cid) state.resolved = { kind: "record", uri: conn.subject.uri, cid: conn.subject.cid };
  showTargetHint();
  setStatus($("conn-status"), "");
  $("conn-form").hidden = false;
  $("add-conn-btn").hidden = true;
  $("c-rel").focus();
}

function closeConnForm() {
  state.editingConn = null;
  $("conn-form").hidden = true;
  $("add-conn-btn").hidden = false;
  $("add-conn-btn").focus();
}

function showTargetHint(text, kind) {
  const hint = $("c-target-hint");
  hint.className = `hint ${kind || ""}`.trim();
  if (text) hint.textContent = text;
  else if (state.resolved?.kind === "record") hint.textContent = `Pinned to version ${state.resolved.cid.slice(0, 16)}…`;
  else hint.textContent = "Looking up pins a record to its current version, so later changes to it show up.";
}

$("c-target").addEventListener("input", () => {
  state.resolved = null;
  showTargetHint();
});

async function lookUpTarget() {
  const q = $("c-target").value.trim();
  if (!q) {
    showTargetHint("Add a handle, DID or at:// link first.", "status err");
    return null;
  }
  showTargetHint("Looking up…");
  try {
    const r = await api("GET", `/api/resolve?q=${encodeURIComponent(q)}`);
    state.resolved = r;
    if (r.kind === "party") {
      $("c-target").value = r.did;
      if (!$("c-name").value && r.handle) $("c-name").value = r.handle;
      showTargetHint(`Found ${r.handle ? `@${r.handle}, ` : ""}${r.did}.`, "status ok");
    } else {
      $("c-target").value = r.uri;
      showTargetHint();
    }
    return r;
  } catch (err) {
    showTargetHint(err.message, "status err");
    return null;
  }
}

$("c-lookup").addEventListener("click", lookUpTarget);
$("add-conn-btn").addEventListener("click", () => openConnForm(null));
$("conn-cancel").addEventListener("click", closeConnForm);

$("conn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let target = $("c-target").value.trim();
  // A handle needs a lookup to become a DID; do it now rather than refuse.
  if (target && !target.startsWith("did:") && !target.startsWith("at://")) {
    const r = await lookUpTarget();
    if (!r) return;
    target = $("c-target").value.trim();
  }
  const relationship = $("c-rel").value === "__other" ? $("c-rel-other").value : $("c-rel").value;
  const name = $("c-name").value.trim();
  const subject = target.startsWith("at://")
    ? { uri: target, ...(state.resolved?.kind === "record" && state.resolved.uri === target ? { cid: state.resolved.cid } : {}) }
    : { did: target, ...(name ? { name } : {}) };
  try {
    const base = `/api/personas/${encodeURIComponent(state.id)}/connections`;
    const input = { subject, relationship, role: $("c-role").value, note: $("c-note").value };
    const { persona } = state.editingConn === "new"
      ? await api("POST", base, input)
      : await api("PUT", `${base}/${state.editingConn}`, input);
    closeConnForm();
    await applyPersona(persona);
  } catch (err) {
    setStatus($("conn-status"), describeIssues(err), "err");
  }
});

// --- private ----------------------------------------------------------------

function renderPrivate() {
  const entries = Object.entries(state.persona.private || {});
  $("private-list").replaceChildren(
    ...entries.map(([k, v]) =>
      h("div", { class: "private-row" },
        h("dt", {}, k),
        h("dd", {}, v),
        h("dd", {}, h("button", {
          type: "button", class: "btn-link", "aria-label": `Remove ${k}`,
          onclick: async () => applyPersona((await api("PUT", `/api/personas/${encodeURIComponent(state.id)}/private`, { key: k, value: "" })).persona),
        }, "Remove"))))
  );
  renderPrivateSuggestions();
}

function renderPrivateSuggestions() {
  const wizard = safeStorage(() => JSON.parse(localStorage.getItem(WIZARD_KEY)), null);
  let keys = DEFAULT_SUGGESTIONS;
  if (wizard?.fields) {
    keys = Object.entries(wizard.fields)
      .filter(([, f]) => f.included && f.visibility !== "public")
      .flatMap(([id]) => PRIVATE_SUGGESTIONS[id] || []);
  }
  const have = new Set(Object.keys(state.persona?.private || {}));
  keys = keys.filter((k) => !have.has(k));
  $("private-suggestions").replaceChildren(
    ...(keys.length
      ? [h("span", { class: "suggestions-label" }, wizard?.fields ? "From your storage guide answers:" : "For example:"),
         ...keys.map((k) => h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => { $("pv-key").value = k; $("pv-value").focus(); } }, k))]
      : [])
  );
}

$("private-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("pv-key").value.trim();
  const value = $("pv-value").value.trim();
  if (!key || !value) {
    setStatus($("private-status"), "Add both what it is and the detail.", "err");
    return;
  }
  try {
    const { persona } = await api("PUT", `/api/personas/${encodeURIComponent(state.id)}/private`, { key, value });
    $("pv-key").value = "";
    $("pv-value").value = "";
    await applyPersona(persona);
    setStatus($("private-status"), "Kept on this computer", "ok");
    $("pv-key").focus();
  } catch (err) {
    setStatus($("private-status"), describeIssues(err), "err");
  }
});

// --- publish ----------------------------------------------------------------

function latest(records) {
  return Object.values(records || {}).map((r) => r.publishedAt).sort().pop();
}

function renderPublishStates() {
  const pubs = state.persona.publications || {};
  const at = pubs.atproto;
  const atEl = $("atproto-state");
  if (at && Object.keys(at.records || {}).length) {
    atEl.textContent = `Published from ${at.did}, last on ${formatDate(latest(at.records))}`;
    atEl.className = "target-state live";
    $("a-handle").value = $("a-handle").value || at.did;
    if (at.pdsUrl && !$("a-pds").dataset.touched) $("a-pds").value = at.pdsUrl;
  } else {
    atEl.textContent = "Not published here yet";
    atEl.className = "target-state";
  }
  for (const [key, el] of [["static", "static-state"], ["solid", "solid-state"]]) {
    const p = pubs[key];
    $(el).textContent = p ? `Last ${key === "static" ? "saved" : "published"} ${formatDate(p.publishedAt)}` : "Not published here yet";
    $(el).className = p ? "target-state live" : "target-state";
  }
}
$("a-pds").addEventListener("input", () => ($("a-pds").dataset.touched = "1"));

async function refreshPlan() {
  if (!state.id) return;
  const el = $("atproto-plan");
  try {
    const plan = await api("GET", `/api/personas/${encodeURIComponent(state.id)}/publish/atproto/plan`);
    const parts = [
      plan.create.length && `${plan.create.length} new`,
      plan.update.length && `${plan.update.length} changed`,
      plan.delete.length && `${plan.delete.length} to remove`,
    ].filter(Boolean);
    el.textContent = parts.length
      ? `Ready to publish: ${parts.join(", ")}.`
      : "Everything here is published and up to date.";
  } catch (err) {
    el.textContent = describeIssues(err);
  }
}

$("a-sandbox").addEventListener("click", () => {
  $("a-pds").value = `${location.origin}/sandbox/atproto`;
  $("a-pds").dataset.touched = "1";
  $("a-handle").value = `${state.id}.creativeid.local`;
  $("a-password").value = "sandbox";
  setStatus($("atproto-status"), "Set up to publish to a pretend PDS inside the studio. Nothing leaves this computer.");
});

$("atproto-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("atproto-status");
  setStatus(status, "Publishing…");
  try {
    const { result, persona } = await api("POST", `/api/personas/${encodeURIComponent(state.id)}/publish/atproto`, {
      pdsUrl: $("a-pds").value.trim(),
      identifier: $("a-handle").value.trim(),
      password: $("a-password").value,
    });
    $("a-password").value = "";
    const parts = [
      result.created.length && `${result.created.length} new`,
      result.updated.length && `${result.updated.length} updated`,
      result.deleted.length && `${result.deleted.length} removed`,
    ].filter(Boolean);
    await applyPersona(persona);
    setStatus(status, parts.length ? `Published: ${parts.join(", ")}.` : "Published. Nothing had changed.", "ok");
    refreshPlan();
  } catch (err) {
    setStatus(status, describeIssues(err), "err");
    if (err.status === 502) applyPersona((await api("GET", `/api/personas/${encodeURIComponent(state.id)}`)).persona);
  }
});

$("s-download").addEventListener("click", () => {
  const params = new URLSearchParams({ format: $("s-format").value });
  if ($("s-url").value.trim()) params.set("publicUrl", $("s-url").value.trim());
  location.href = `/api/personas/${encodeURIComponent(state.id)}/export/download?${params}`;
});

$("static-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const format = $("s-format").value;
    const { result, persona } = await api("POST", `/api/personas/${encodeURIComponent(state.id)}/publish/static`, {
      format,
      publicUrl: $("s-url").value.trim() || undefined,
    });
    await applyPersona(persona);
    setStatus($("static-status"), `Saved to ${result.outputPath.split(/[\\/]/).slice(-4).join("/")}`, "ok");
  } catch (err) {
    setStatus($("static-status"), describeIssues(err), "err");
  }
});

$("o-sandbox").addEventListener("click", () => {
  $("o-url").value = `${location.origin}/sandbox/solid/${state.id}/creativeid.${$("o-format").value === "jsonld" ? "jsonld" : "ttl"}`;
  setStatus($("solid-status"), "Set up to publish to a pretend Pod inside the studio. Nothing leaves this computer.");
});

$("solid-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus($("solid-status"), "Publishing…");
  try {
    const { result, persona } = await api("POST", `/api/personas/${encodeURIComponent(state.id)}/publish/solid`, {
      resourceUrl: $("o-url").value.trim(),
      format: $("o-format").value,
      authToken: $("o-token").value || undefined,
    });
    await applyPersona(persona);
    setStatus($("solid-status"), `Published to ${result.resourceUrl}`, "ok");
  } catch (err) {
    setStatus($("solid-status"), describeIssues(err), "err");
  }
});

// --- wall label -------------------------------------------------------------

function renderLabel() {
  if (!state.persona) return;
  const live = $("studio").hidden ? state.persona.profile : { ...state.persona.profile, ...readLabelFields() };
  const { works, connections, publications } = state.persona;

  const sub = [
    live.disciplines?.length ? live.disciplines.join(", ") : null,
    live.based?.name ? `based in ${live.based.name}` : null,
  ].filter(Boolean).join(", ");

  const pubLine = [];
  if (publications?.atproto?.records && Object.keys(publications.atproto.records).length) pubLine.push("AT Protocol");
  if (publications?.solid) pubLine.push("a Solid Pod");
  if (publications?.static) pubLine.push("a static file");

  $("wall-label").replaceChildren(
    h("p", { class: "wl-name" }, live.name || "Untitled persona"),
    sub ? h("p", { class: "wl-sub" }, sub.charAt(0).toUpperCase() + sub.slice(1)) : null,
    live.bio
      ? h("p", { class: "wl-bio" }, live.bio)
      : h("p", { class: "wl-bio placeholder" }, "A few lines about your practice will appear here."),
    works.length
      ? h("ul", { class: "wl-works", "aria-label": "Works" },
          ...works.map((w) => h("li", {},
            h("span", { class: "wl-work-title" }, w.title),
            w.completionDate ? `, ${w.completionDate}` : "",
            otherCredits(w.credits).length ? h("span", { class: "wl-work-meta" }, creditsText(otherCredits(w.credits))) : null)))
      : null,
    connections.length
      ? h("p", { class: "wl-conns" },
          connections.map((c) => `${(REL_LABEL[c.relationship] || c.relationship).replace(/^am /, "")} ${targetText(c)}`)
            .join("; ").replace(/^\w/, (x) => x.toUpperCase()) + ".")
      : null,
    h("p", { class: "wl-foot" },
      pubLine.length ? `Published to ${pubLine.join(" and ")}.` : "Only on this computer. Not published anywhere yet.")
  );
}

/** The profile fields as currently typed, so the label updates before saving. */
function readLabelFields() {
  return {
    name: $("p-name").value.trim(),
    bio: $("p-bio").value.trim(),
    disciplines: [...$("p-disciplines").querySelectorAll(".tag-chip")].map((c) => c.firstChild.textContent),
    based: $("p-based").value.trim() ? { name: $("p-based").value.trim() } : undefined,
  };
}

// --- inspector ----------------------------------------------------------------

function renderInspector() {
  const p = state.previews;
  if (!p) return;
  const text =
    state.inspector === "turtle"
      ? p.turtle
      : JSON.stringify(state.inspector === "jsonld" ? p.jsonld : p.atproto, null, 2);
  $("inspector-code").textContent = text;
}

$("copy-btn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("inspector-code").textContent);
    $("copy-btn").textContent = "Copied";
  } catch {
    $("copy-btn").textContent = "Couldn't copy";
  }
  setTimeout(() => ($("copy-btn").textContent = "Copy"), 1500);
});

// ------------------------------------------------------------------ start

loadPersonas().catch((err) => {
  $("local-status").textContent = `Couldn't open your personas: ${err.message}`;
});
