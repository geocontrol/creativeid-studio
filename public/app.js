const segmenter =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter("en", { granularity: "grapheme" })
    : null;

function countGraphemes(text) {
  if (!segmenter) return Array.from(text).length;
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

const state = {
  persona: null,
  previews: {
    canonicalJsonLd: null,
    publicJsonLd: null,
    atprotoRecord: null,
    solidTurtle: "",
  },
  activeTab: "canonicalJsonLd",
};

const els = {
  storageDot: document.getElementById("storage-dot"),
  storageStatusText: document.getElementById("storage-status-text"),
  storageFilePath: document.getElementById("storage-file-path"),
  personaForm: document.getElementById("persona-form"),
  nameInput: document.getElementById("persona-name"),
  bioInput: document.getElementById("persona-bio"),
  idInput: document.getElementById("persona-id"),
  nameCounter: document.getElementById("name-counter"),
  bioCounter: document.getElementById("bio-counter"),
  saveStatus: document.getElementById("save-status"),
  cardId: document.getElementById("card-id"),
  cardName: document.getElementById("card-name"),
  cardBio: document.getElementById("card-bio"),
  cardModified: document.getElementById("card-modified"),
  publicationsStrip: document.getElementById("publications-strip"),
  inspectorCode: document.getElementById("inspector-code"),
  copyPayloadBtn: document.getElementById("copy-payload-btn"),
  tabs: document.querySelectorAll(".tab"),
  atprotoForm: document.getElementById("atproto-form"),
  atprotoPds: document.getElementById("atproto-pds"),
  atprotoHandle: document.getElementById("atproto-handle"),
  atprotoPassword: document.getElementById("atproto-password"),
  atprotoStatus: document.getElementById("atproto-status"),
  atprotoSandboxBtn: document.getElementById("atproto-sandbox-btn"),
  solidForm: document.getElementById("solid-form"),
  solidUrl: document.getElementById("solid-url"),
  solidFormat: document.getElementById("solid-format"),
  solidToken: document.getElementById("solid-token"),
  solidStatus: document.getElementById("solid-status"),
  solidSandboxBtn: document.getElementById("solid-sandbox-btn"),
  staticForm: document.getElementById("static-form"),
  staticFormat: document.getElementById("static-format"),
  staticUrl: document.getElementById("static-url"),
  staticStatus: document.getElementById("static-status"),
  downloadStaticBtn: document.getElementById("download-static-btn"),
};

function setStatus(el, text, type = "") {
  el.textContent = text;
  el.className = `status-msg ${type}`.trim();
}

function updateCounters() {
  const nameCount = countGraphemes(els.nameInput.value.trim());
  const bioCount = countGraphemes(els.bioInput.value.trim());

  els.nameCounter.textContent = `${nameCount} / 64`;
  els.nameCounter.classList.toggle("over", nameCount > 64);

  els.bioCounter.textContent = `${bioCount} / 1000`;
  els.bioCounter.classList.toggle("over", bioCount > 1000);

  // Live card preview while typing
  els.cardName.textContent =
    els.nameInput.value.trim() || state.persona?.name || "Unpublished Persona";
  els.cardBio.textContent =
    els.bioInput.value.trim() ||
    state.persona?.description ||
    "Enter a name and biography above to preview and save your local CreativeID persona.";
  els.cardId.textContent = els.idInput.value.trim() || "#me";
}

function renderInspector() {
  const tab = state.activeTab;
  const payload = state.previews[tab];
  if (tab === "solidTurtle") {
    els.inspectorCode.textContent = payload || "# Save persona to view Turtle output";
    return;
  }
  if (!payload) {
    els.inspectorCode.textContent =
      "// No local persona saved yet. Author and save your persona above.";
    return;
  }
  els.inspectorCode.textContent = JSON.stringify(payload, null, 2);
}

function renderPublications(pubs = {}) {
  els.publicationsStrip.innerHTML = "";
  const entries = [
    { key: "atproto", label: "AT Protocol PDS" },
    { key: "solid", label: "Solid Pod" },
    { key: "static", label: "Static Export" },
  ];

  for (const { key, label } of entries) {
    const info = pubs[key];
    if (!info) continue;
    const div = document.createElement("div");
    div.className = "pub-badge";
    const left = document.createElement("span");
    left.innerHTML = `<strong>${label}:</strong> <code>${info.uri}</code>`;
    const right = document.createElement("span");
    right.textContent = new Date(info.publishedAt).toLocaleTimeString();
    div.append(left, right);
    els.publicationsStrip.appendChild(div);
  }
}

function applyServerState(data) {
  state.persona = data.persona;
  state.previews = data.previews;
  if (data.filePath) {
    els.storageFilePath.textContent = data.filePath;
  }

  if (state.persona) {
    els.storageDot.classList.add("saved");
    els.storageStatusText.textContent = "Saved on Local Disk";
    els.nameInput.value = state.persona.name;
    els.bioInput.value = state.persona.description;
    els.idInput.value = state.persona["@id"] || "#me";
    els.cardModified.textContent = new Date(
      state.persona.dateModified
    ).toLocaleString();
    renderPublications(state.persona["creativeid:publications"] || {});
  } else {
    els.storageDot.classList.remove("saved");
    els.storageStatusText.textContent = "Not Yet Saved Locally";
    els.cardModified.textContent = "Never";
    renderPublications({});
  }

  updateCounters();
  renderInspector();
}

async function loadInitialPersona() {
  try {
    const res = await fetch("/api/persona");
    const data = await res.json();
    applyServerState(data);
  } catch (err) {
    els.storageStatusText.textContent = "Offline / Server Unreachable";
  }
}

els.nameInput.addEventListener("input", updateCounters);
els.bioInput.addEventListener("input", updateCounters);
els.idInput.addEventListener("input", updateCounters);

els.tabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    els.tabs.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.activeTab = btn.dataset.tab;
    renderInspector();
  });
});

els.copyPayloadBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.inspectorCode.textContent);
  const orig = els.copyPayloadBtn.textContent;
  els.copyPayloadBtn.textContent = "Copied!";
  setTimeout(() => {
    els.copyPayloadBtn.textContent = orig;
  }, 1500);
});

els.personaForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus(els.saveStatus, "Saving...", "");
  try {
    const res = await fetch("/api/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: els.nameInput.value,
        biography: els.bioInput.value,
        id: els.idInput.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data.issues
        ? data.issues.map((i) => i.message).join(" ")
        : data.error;
      setStatus(els.saveStatus, msg || "Failed to save", "err");
      return;
    }
    applyServerState(data);
    setStatus(els.saveStatus, "Saved to local store!", "ok");
  } catch (err) {
    setStatus(els.saveStatus, err.message, "err");
  }
});

// Sandbox helper buttons for immediate local testing
els.atprotoSandboxBtn.addEventListener("click", () => {
  els.atprotoPds.value = `${window.location.origin}/sandbox/atproto`;
  els.atprotoHandle.value = "ada.creativeid.local";
  els.atprotoPassword.value = "sandbox-app-password";
  setStatus(els.atprotoStatus, "Configured for local ATProto PDS sandbox", "");
});

els.solidSandboxBtn.addEventListener("click", () => {
  const ext = els.solidFormat.value === "jsonld" ? "jsonld" : "ttl";
  els.solidUrl.value = `${window.location.origin}/sandbox/solid/public/creativeid.${ext}`;
  els.solidToken.value = "sandbox-solid-token";
  setStatus(els.solidStatus, "Configured for local Solid Pod sandbox", "");
});

els.atprotoForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus(els.atprotoStatus, "Publishing to ATProto PDS...", "");
  try {
    const res = await fetch("/api/publish/atproto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdsUrl: els.atprotoPds.value,
        identifier: els.atprotoHandle.value,
        password: els.atprotoPassword.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(els.atprotoStatus, data.error || "Publish failed", "err");
      return;
    }
    applyServerState(data);
    setStatus(els.atprotoStatus, `Published: ${data.result.status.uri}`, "ok");
  } catch (err) {
    setStatus(els.atprotoStatus, err.message, "err");
  }
});

els.solidForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus(els.solidStatus, "Publishing to Solid Pod...", "");
  try {
    const res = await fetch("/api/publish/solid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceUrl: els.solidUrl.value,
        format: els.solidFormat.value,
        authToken: els.solidToken.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(els.solidStatus, data.error || "Publish failed", "err");
      return;
    }
    applyServerState(data);
    setStatus(els.solidStatus, `Published: ${data.result.status.uri}`, "ok");
  } catch (err) {
    setStatus(els.solidStatus, err.message, "err");
  }
});

els.staticForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus(els.staticStatus, "Exporting file...", "");
  try {
    const res = await fetch("/api/publish/static", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: els.staticFormat.value,
        publicUrl: els.staticUrl.value || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(els.staticStatus, data.error || "Export failed", "err");
      return;
    }
    applyServerState(data);
    setStatus(
      els.staticStatus,
      `Exported to ${data.result.outputPath}`,
      "ok"
    );
  } catch (err) {
    setStatus(els.staticStatus, err.message, "err");
  }
});

els.downloadStaticBtn.addEventListener("click", () => {
  const format = encodeURIComponent(els.staticFormat.value);
  const publicUrl = encodeURIComponent(els.staticUrl.value || "");
  window.location.href = `/api/export/download?format=${format}&publicUrl=${publicUrl}`;
});

loadInitialPersona();
