// Storage Guide wizard — helps creators choose between an AT Protocol PDS,
// a Solid Pod, static hosting, or a combination. Pure client-side; answers
// are persisted to localStorage so the guide survives reloads.

const STORAGE_KEY = "cp.storageGuide.v1";

/** Field groups a Creative Passport may contain, with a sensible default visibility. */
const FIELD_GROUPS = [
  { id: "identity", label: "Name, biography & genres", hint: "Your public creative identity", default: "public", included: true },
  { id: "links", label: "Website, socials & press photos", hint: "Links and promotional assets", default: "public", included: true },
  { id: "booking", label: "Booking & management contacts", hint: "Email, phone, agent details", default: "shared", included: false },
  { id: "commercial", label: "Fees, tech rider & availability", hint: "Info for promoters and festivals", default: "shared", included: false },
  { id: "rights", label: "Legal name & rights identifiers", hint: "IPI, ISNI, ISRC ownership, PRO membership", default: "shared", included: false },
  { id: "payment", label: "Payment & royalty details", hint: "Bank, tax and split information", default: "private", included: false },
  { id: "drafts", label: "Drafts & unreleased work", hint: "Notes, demos, works in progress", default: "private", included: false },
];

const VISIBILITY = {
  public: { label: "Everyone", short: "Public" },
  shared: { label: "Specific people / organisations", short: "Shared" },
  private: { label: "Only me", short: "Private" },
};

/** Goal questions. Each option can nudge scores and set flags. */
const QUESTIONS = [
  {
    id: "discover",
    q: "Should apps and directories be able to discover you automatically?",
    help: "AT Protocol broadcasts records to the whole network, so festivals, directories and apps can find you without you registering anywhere.",
    options: [
      { v: "yes", label: "Yes, I want to be found", s: { pds: 3 } },
      { v: "unsure", label: "Not sure", s: { pds: 1 } },
      { v: "no", label: "No, I'll share links myself", s: { static: 1, solid: 1 } },
    ],
  },
  {
    id: "account",
    q: "Do you already have a Bluesky or other AT Protocol account?",
    options: [
      { v: "yes", label: "Yes", s: { pds: 2 } },
      { v: "no", label: "No, but happy to create one", s: { pds: 1 } },
      { v: "avoid", label: "I'd rather not", s: { pds: -3 } },
    ],
  },
  {
    id: "signed",
    q: "How important is cryptographic proof that the data really came from you?",
    help: "Every PDS record is signed and content-addressed (CID). Solid and static rely on HTTPS and domain trust.",
    options: [
      { v: "high", label: "Very important", s: { pds: 2 } },
      { v: "nice", label: "Nice to have", s: { pds: 1 } },
      { v: "low", label: "Not important", s: {} },
    ],
  },
  {
    id: "domain",
    q: "Do you own (or want) your own domain name?",
    help: "A domain lets you host a durable static copy and use it as your AT Protocol handle.",
    options: [
      { v: "yes", label: "Yes", s: { static: 2 } },
      { v: "no", label: "No", s: { static: -1 } },
    ],
  },
  {
    id: "jurisdiction",
    q: "Where would you like your data hosted?",
    options: [
      { v: "any", label: "No preference", s: {} },
      { v: "eu", label: "In the EU (GDPR)", s: {} },
      { v: "self", label: "On infrastructure I control", s: {} },
    ],
  },
  {
    id: "skill",
    q: "How comfortable are you with technical setup?",
    options: [
      { v: "none", label: "Keep it simple", s: { solid: -1 } },
      { v: "some", label: "I can follow instructions", s: {} },
      { v: "dev", label: "I'm a developer / have help", s: { solid: 1 } },
    ],
  },
  {
    id: "change",
    q: "How often will your passport change?",
    options: [
      { v: "rarely", label: "Rarely", s: { static: 1 } },
      { v: "often", label: "Often (tours, releases, availability)", s: { pds: 1, solid: 1, static: -1 } },
    ],
  },
  {
    id: "durable",
    q: "Should your passport keep working if one provider disappears?",
    options: [
      { v: "yes", label: "Yes, keep a backup copy", s: { static: 1 } },
      { v: "no", label: "One place is fine", s: {} },
    ],
  },
];

const STORES = {
  pds: { name: "AT Protocol PDS", icon: "🦋", color: "pds" },
  solid: { name: "Solid Pod", icon: "🔐", color: "solid" },
  static: { name: "Static hosting", icon: "📄", color: "static" },
};

// ---------------------------------------------------------------- state

function defaultState() {
  return {
    step: 0,
    fields: Object.fromEntries(FIELD_GROUPS.map((f) => [f.id, { included: f.included, visibility: f.default }])),
    answers: {},
  };
}

let state = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.fields) return { ...defaultState(), ...saved, step: 0 };
  } catch { /* ignore corrupt storage */ }
  return defaultState();
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------- recommendation engine

/** Pure function: turns answers into a recommendation. Exported for testing. */
export function recommend({ fields, answers }) {
  const included = FIELD_GROUPS.filter((f) => fields[f.id]?.included);
  const byVis = (v) => included.filter((f) => fields[f.id].visibility === v);
  const publicF = byVis("public");
  const sharedF = byVis("shared");
  const privateF = byVis("private");
  const needsAccessControl = sharedF.length + privateF.length > 0;

  const scores = { pds: 0, solid: 0, static: 0 };
  for (const q of QUESTIONS) {
    const opt = q.options.find((o) => o.v === answers[q.id]);
    if (opt) for (const [k, v] of Object.entries(opt.s)) scores[k] += v;
  }
  if (needsAccessControl) scores.solid += 5;
  if (sharedF.length) scores.solid += 1;

  const wantsDiscovery = answers.discover !== "no";
  const avoidsPds = answers.account === "avoid";
  const hasDomain = answers.domain === "yes";
  const wantsBackup = answers.durable === "yes";

  const usePds = publicF.length > 0 && !avoidsPds && (wantsDiscovery || scores.pds >= 3);
  const useSolid = needsAccessControl;
  const useStatic = publicF.length > 0 && ((hasDomain && (wantsBackup || !usePds)) || (!usePds && !useSolid));

  const stores = [usePds && "pds", useSolid && "solid", useStatic && "static"].filter(Boolean);
  if (!stores.length) stores.push(needsAccessControl ? "solid" : "static");

  // Route every included field to the stores that may hold it.
  // Public fields go to the public stores (PDS / static); if neither is chosen they
  // live in Solid's world-readable /public/ container. Shared/private => Solid only.
  const publicStores = stores.filter((s) => s !== "solid");
  const routing = included.map((f) => {
    const vis = fields[f.id].visibility;
    const targets = vis !== "public" ? ["solid"] : publicStores.length ? publicStores : ["solid"];
    return { ...f, visibility: vis, targets };
  });

  const pattern = pickPattern(stores);
  const providers = pickProviders(stores, answers);
  const warnings = buildWarnings({ stores, needsAccessControl, answers, publicF });
  const steps = buildSteps({ stores, hasDomain, providers });

  return { stores, scores, routing, pattern, providers, warnings, steps, needsAccessControl, counts: { public: publicF.length, shared: sharedF.length, private: privateF.length } };
}

function pickPattern(stores) {
  const key = ["pds", "solid", "static"].filter((s) => stores.includes(s)).join("+");
  const patterns = {
    "pds": { title: "AT Protocol PDS", tag: "Discoverable & signed", text: "Everything you plan to share is public, and you want to be found. Publish a signed Lexicon record to your PDS and every AT Protocol app and aggregator can discover it in real time." },
    "solid": { title: "Solid Pod with public & private containers", tag: "Privacy-first", text: "Keep public details in your Pod's /public/ container and protected details in containers you grant to specific people or organisations. Ping the aggregator so you can be found." },
    "static": { title: "Static file on the web", tag: "Simplest & most durable", text: "Host a single JSON-LD file at /.well-known/creative-passport.jsonld. Nothing to log into, almost free, and it lasts as long as your domain does." },
    "pds+static": { title: "PDS + static mirror on your domain", tag: "Discoverable & resilient", text: "Publish to your PDS for network discovery, and mirror the same public data on your own domain. Use the domain as your AT Protocol handle so both point at one identity." },
    "pds+solid": { title: "Public on PDS, private on Solid", tag: "Best of both ⭐", text: "Your public persona lives on the PDS where everyone can discover it. Sensitive details live in your Solid Pod, and your PDS record points to them. Partners request access; you grant or revoke it per WebID." },
    "solid+static": { title: "Solid for private, static for public", tag: "Private + durable", text: "A static file on your domain carries your public persona; your Solid Pod holds access-controlled details for specific partners." },
    "pds+solid+static": { title: "All three: discover, protect, persist", tag: "Full stack", text: "PDS for discovery and signatures, a static mirror on your domain as the durable canonical URL, and a Solid Pod for everything that needs access control." },
  };
  return { key, ...patterns[key] };
}

function pickProviders(stores, a) {
  const out = {};
  if (stores.includes("pds")) {
    out.pds = a.jurisdiction === "self" && a.skill !== "none"
      ? { name: "Self-hosted PDS", detail: "bluesky-social/pds installer on a ~$5/month VPS", url: "https://github.com/bluesky-social/pds" }
      : a.jurisdiction === "eu"
        ? { name: "Eurosky", detail: "Non-profit, EU-hosted PDS (GDPR)", url: "https://eurosky.tech" }
        : { name: "Bluesky", detail: "Fastest start with bsky.social", url: "https://bsky.app" };
  }
  if (stores.includes("solid")) {
    out.solid = a.jurisdiction === "self" && a.skill !== "none"
      ? { name: "Community Solid Server", detail: "Self-host @solid/community-server behind Caddy", url: "https://communitysolidserver.github.io/CommunitySolidServer/" }
      : a.skill === "dev"
        ? { name: "Inrupt PodSpaces", detail: "Managed pods with Access Control Policies", url: "https://start.inrupt.com" }
        : { name: "solidweb.me / solidcommunity.net", detail: "Free community pod providers", url: "https://solidproject.org/users/get-a-pod" };
  }
  if (stores.includes("static")) {
    out.static = a.domain === "yes"
      ? { name: "Your own domain", detail: "Serve /.well-known/creative-passport.jsonld with CORS", url: null }
      : { name: "GitHub Pages / Cloudflare Pages", detail: "Free static hosting; add a domain later", url: "https://pages.github.com" };
  }
  return out;
}

function buildWarnings({ stores, needsAccessControl, answers, publicF }) {
  const w = [];
  if (stores.includes("pds")) {
    w.push({ level: "warn", text: "Treat anything written to a PDS as published forever. Records are broadcast to relays and aggregators, so deleting them doesn't erase copies." });
    if (needsAccessControl) w.push({ level: "info", text: "Your PDS record will link to your Solid data. That reveals that protected data exists, but not what it contains." });
    w.push({ level: "info", text: "Private data on AT Protocol is on the roadmap but not available yet. When it ships, this recommendation may simplify." });
  }
  if (needsAccessControl && answers.skill === "none") {
    w.push({ level: "warn", text: "Solid login (Solid-OIDC) and access control take a bit more setup. Consider asking your manager or label to help." });
  }
  if (stores.includes("static") && !stores.includes("pds")) {
    w.push({ level: "info", text: "Static files aren't announced to anyone. Ping the Creative Passport Aggregator after publishing so you can be found." });
  }
  if (!publicF.length) {
    w.push({ level: "info", text: "You have no public fields, so nothing will be discoverable. That's fine if you only share with specific partners." });
  }
  return w;
}

function buildSteps({ stores, hasDomain, providers }) {
  const s = ["Write your persona once in the Persona Studio. It stays on your machine as the single source of truth."];
  if (stores.includes("pds")) s.push(`Create an App Password with ${providers.pds.name} and publish via the AT Protocol PDS card.`);
  if (stores.includes("pds") && hasDomain) s.push("Set your domain as your AT Protocol handle (DNS TXT record _atproto).");
  if (stores.includes("solid")) s.push(`Register a pod with ${providers.solid.name}. Put public data in /public/ and protected data in a separate container with access rules.`);
  if (stores.includes("static")) s.push("Export a static JSON-LD file and upload it to /.well-known/creative-passport.jsonld.");
  if (stores.length > 1) s.push("Cross-link your stores with sameAs (DID ↔ WebID ↔ URL) so aggregators know it's all you.");
  s.push("Ping the Creative Passport Aggregator so directories can find you straight away.");
  return s;
}

// ---------------------------------------------------------------- rendering

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderFields() {
  $("field-visibility").innerHTML = FIELD_GROUPS.map((f) => {
    const st = state.fields[f.id];
    return `
      <div class="fv-row ${st.included ? "" : "is-off"}" data-field="${f.id}">
        <label class="fv-include">
          <input type="checkbox" id="fv-inc-${f.id}" ${st.included ? "checked" : ""} />
          <span><strong>${esc(f.label)}</strong><small>${esc(f.hint)}</small></span>
        </label>
        <div class="seg" role="radiogroup" aria-label="Visibility for ${esc(f.label)}">
          ${Object.entries(VISIBILITY).map(([v, meta]) => `
            <button type="button" role="radio" id="fv-${f.id}-${v}" class="seg-btn seg-${v} ${st.visibility === v ? "active" : ""}"
              aria-checked="${st.visibility === v}" data-vis="${v}" ${st.included ? "" : "disabled"}>${meta.label}</button>`).join("")}
        </div>
      </div>`;
  }).join("");
}

function renderQuestions() {
  $("wizard-questions").innerHTML = QUESTIONS.map((q, i) => `
    <fieldset class="question" data-q="${q.id}">
      <legend><span class="q-num">${i + 1}</span>${esc(q.q)}</legend>
      ${q.help ? `<p class="q-help">${esc(q.help)}</p>` : ""}
      <div class="q-options">
        ${q.options.map((o) => `
          <button type="button" id="q-${q.id}-${o.v}" class="q-opt ${state.answers[q.id] === o.v ? "active" : ""}" data-v="${o.v}">${esc(o.label)}</button>`).join("")}
      </div>
    </fieldset>`).join("");
}

function renderResult() {
  const r = recommend(state);
  const max = Math.max(1, ...Object.values(r.scores).map((v) => Math.max(0, v)));
  const lane = (key) => {
    const fields = r.routing.filter((f) => f.targets.includes(key));
    const p = r.providers[key];
    return `
      <div class="lane lane-${key}">
        <div class="lane-head"><span class="lane-icon">${STORES[key].icon}</span><div><h4>${STORES[key].name}</h4>${p ? `<small>${p.url ? `<a href="${p.url}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)} · ${esc(p.detail)}</small>` : ""}</div></div>
        <ul>${fields.map((f) => `<li><span class="vis-dot vis-${f.visibility}"></span>${esc(f.label)}<em>${VISIBILITY[f.visibility].short}</em></li>`).join("") || "<li class='muted'>Linked from your other stores</li>"}</ul>
      </div>`;
  };

  $("wizard-result").innerHTML = `
    <div class="result-hero">
      <span class="result-tag">${esc(r.pattern.tag)}</span>
      <h2>${esc(r.pattern.title)}</h2>
      <p>${esc(r.pattern.text)}</p>
      <div class="result-chips">
        <span class="chip vis-public">${r.counts.public} public</span>
        <span class="chip vis-shared">${r.counts.shared} shared</span>
        <span class="chip vis-private">${r.counts.private} private</span>
      </div>
    </div>

    <div class="result-grid">
      <div class="panel">
        <div class="panel-header"><h2>Where each part of your data goes</h2></div>
        <div class="lanes">${r.stores.map(lane).join("")}</div>
      </div>

      <div class="panel">
        <div class="panel-header"><h2>How each option scored for you</h2></div>
        <div class="scores">
          ${Object.keys(STORES).map((k) => `
            <div class="score-row ${r.stores.includes(k) ? "chosen" : ""}">
              <span>${STORES[k].icon} ${STORES[k].name}</span>
              <div class="bar"><i class="bar-${k}" style="width:${Math.max(4, (Math.max(0, r.scores[k]) / max) * 100)}%"></i></div>
              <b>${r.stores.includes(k) ? "Recommended" : ""}</b>
            </div>`).join("")}
        </div>
        ${r.needsAccessControl ? `<p class="rule-note">🔒 You have shared or private fields. <strong>They can only go to Solid</strong>, because PDS and static hosting are public-only.</p>` : ""}
      </div>
    </div>

    <div class="result-grid">
      <div class="panel">
        <div class="panel-header"><h2>Next steps</h2></div>
        <ol class="next-steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        <div class="form-actions">
          <button type="button" class="btn btn-accent" id="wizard-go-studio">Open the publish cards in the Studio →</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>Things to know</h2></div>
        <ul class="warnings">${r.warnings.map((w) => `<li class="w-${w.level}">${esc(w.text)}</li>`).join("")}</ul>
      </div>
    </div>`;

  $("wizard-go-studio").addEventListener("click", () => {
    showView("view-studio");
    highlightAdapters(r.stores);
  });
}

function renderStep() {
  [0, 1, 2].forEach((i) => ($(`wizard-step-${i}`).hidden = i !== state.step));
  document.querySelectorAll("#wizard-stepper li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("active", n === state.step);
    li.classList.toggle("done", n < state.step);
  });
  $("wizard-back").disabled = state.step === 0;
  $("wizard-next").hidden = state.step === 2;
  if (state.step === 0) renderFields();
  if (state.step === 1) { renderQuestions(); updateNext(); }
  if (state.step === 2) renderResult();
  if (state.step !== 1) $("wizard-next").disabled = false;
  $("wizard-next").textContent = state.step === 1 ? "See recommendation" : "Next";
}

function updateNext() {
  const answered = QUESTIONS.filter((q) => state.answers[q.id]).length;
  $("wizard-next").disabled = answered < QUESTIONS.length;
  $("wizard-next").title = answered < QUESTIONS.length ? `${QUESTIONS.length - answered} question(s) left` : "";
}

// ---------------------------------------------------------------- view switching

function showView(id) {
  document.querySelectorAll(".app-view").forEach((v) => (v.hidden = v.id !== id));
  document.querySelectorAll(".app-nav-btn").forEach((b) => {
    const on = b.dataset.view === id;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function highlightAdapters(stores) {
  const map = { pds: "atproto-form", solid: "solid-form", static: "static-form" };
  document.querySelectorAll(".adapter-card").forEach((c) => c.classList.remove("recommended"));
  const cards = stores.map((s) => $(map[s])?.closest(".adapter-card")).filter(Boolean);
  cards.forEach((c) => c.classList.add("recommended"));
  cards[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------------------------------------------------------------- events

document.querySelectorAll(".app-nav-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

$("field-visibility").addEventListener("click", (e) => {
  const row = e.target.closest(".fv-row");
  if (!row) return;
  const id = row.dataset.field;
  if (e.target.matches("input[type=checkbox]")) {
    state.fields[id].included = e.target.checked;
  } else if (e.target.closest(".seg-btn")) {
    state.fields[id].visibility = e.target.closest(".seg-btn").dataset.vis;
  } else return;
  save();
  renderFields();
});

$("wizard-questions").addEventListener("click", (e) => {
  const btn = e.target.closest(".q-opt");
  if (!btn) return;
  state.answers[btn.closest(".question").dataset.q] = btn.dataset.v;
  save();
  renderQuestions();
  updateNext();
});

$("wizard-next").addEventListener("click", () => { state.step = Math.min(2, state.step + 1); renderStep(); });
$("wizard-back").addEventListener("click", () => { state.step = Math.max(0, state.step - 1); renderStep(); });
$("wizard-reset").addEventListener("click", () => { state = defaultState(); save(); renderStep(); });

renderStep();
