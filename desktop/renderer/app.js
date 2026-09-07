const $ = (id) => document.getElementById(id);
async function requestJson(url, options) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options }); }
  catch { throw new Error("Unable to connect to Website Cloner. Make sure the local server is running and try again."); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request failed. Please try again.");
  return data;
}
const api = window.websiteCloner || {
  chooseOutputDir: async () => "",
  startMirror: (payload) => requestJson("/api/mirror", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  openPath: async () => {},
  openPreview: () => window.open(window.__job.result.previewUrl, "_blank", "noopener"),
  onProgress: (callback) => {
    let polling = false;
    const timer = setInterval(async () => {
      const current = window.__job;
      if (polling || current?.status !== "running") return;
      polling = true;
      try {
        const event = await requestJson(`/api/mirror/${current.id}`);
        callback({ ...event.progress, id: current.id, status: event.status, result: event.result, error: event.error });
      } catch (error) { callback({ id: current.id, connectionError: error.message }); }
      finally { polling = false; }
    }, 1000);
    window.addEventListener("beforeunload", () => clearInterval(timer), { once: true });
    return () => clearInterval(timer);
  }
};
let job;
let starting = false;
let pendingProgress;
const submitButton = document.querySelector('button[type="submit"]');
const notice = document.querySelector(".notice");
notice.setAttribute("role", "alert");

function setBusy(label) {
  submitButton.disabled = Boolean(label);
  submitButton.textContent = label || "Start cloning";
}

function showFailure(message) {
  $("status").textContent = "Failed";
  $("meta").textContent = message;
  notice.textContent = message;
  setBusy();
}
$("choose").onclick = async () => { const chosen = await api.chooseOutputDir(); if (chosen) $("outputDir").value = chosen; };
$("form").onsubmit = async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return;
  starting = true;
  pendingProgress = undefined;
  job = window.__job = undefined;
  notice.textContent = "";
  $("result").replaceChildren();
  $("bar").style.width = "0%";
  $("status").textContent = "Checking";
  $("meta").textContent = "Checking connection…";
  setBusy("Checking connection…");
  try {
    const protocol = $("protocol").value;
    const username = $("username").value;
    const password = $("password").value;
    const proxyUrl = protocol ? `${protocol}://${username ? encodeURIComponent(username) + (password ? `:${encodeURIComponent(password)}` : "") + "@" : ""}${$("host").value}:${$("port").value}` : "";
    const response = await api.startMirror({ url: $("url").value, proxyUrl, maxDepth: Number($("depth").value), maxPages: Number($("pages").value), outputDir: $("outputDir").value, headless: true });
    if (response.error) throw new Error(response.error);
    job = window.__job = response;
    $("status").textContent = "Running";
    $("meta").textContent = "Browser is capturing the site…";
    setBusy("Cloning…");
  } catch (error) {
    showFailure(error.message || "Unable to start the capture. Please try again.");
  } finally {
    starting = false;
    if (pendingProgress) renderProgress(pendingProgress);
    pendingProgress = undefined;
  }
};

function renderProgress(event) {
  if (!job || event.id !== job.id) return;
  if (event.connectionError) {
    // A lost UI connection does not mean the server-side capture stopped.
    $("status").textContent = "Reconnecting";
    $("meta").textContent = "Connection interrupted. Retrying…";
    notice.textContent = event.connectionError;
    setBusy("Reconnecting…");
    return;
  }
  notice.textContent = "";
  $("status").textContent = "Running";
  setBusy("Cloning…");
  if (event.status) job.status = event.status;
  if (event.result) job.result = event.result;
  if (event.status === "failed") {
    showFailure(event.error || "Capture failed. Please try again.");
    loadHistory();
    return;
  }
  const max = event.maxPages || 1;
  $("bar").style.width = `${Math.min(100, ((event.visited || 0) / max) * 100)}%`;
  $("meta").textContent = `${event.visited || 0} page · ${event.savedAssets || 0} assets · ${((event.bytes || 0) / 1048576).toFixed(1)} MB`;
  if (event.status === "completed") {
    setBusy();
    $("status").textContent = "Completed";
    const result = event.result;
    $("bar").style.width = "100%";
    $("meta").textContent = `${result.pages || 0} page · ${result.files || 0} files · ${((result.bytes || 0) / 1048576).toFixed(1)} MB`;
    const screenshot = window.websiteCloner ? (result.screenshotPath ? encodeURI(`file://${result.screenshotPath}`) : "") : `/preview/${encodeURIComponent(job.id)}/screenshot.png`;
    $("result").innerHTML = `<img src="${screenshot}" alt="Screenshot"><div><h3>${result.host}</h3><p>${result.pages} page · ${result.files || 0} files</p><p>${result.challenge === "none" ? "No challenge detected" : "Challenge detected and reported"}</p><button onclick="api.openPreview(job.id)">Open preview</button><button onclick="api.openPath('${result.outputDir.replace(/'/g, "\\'")}')">Open folder</button></div>`;
    loadHistory();
  }
}

api.onProgress((event) => {
  // IPC progress can arrive before startMirror resolves; replay it once the job is known.
  if (starting) pendingProgress = event;
  else renderProgress(event);
});

async function loadHistory() { if (!api.listMirrors) return; const jobs = await api.listMirrors(); $("historyList").innerHTML = jobs.length ? jobs.map((item) => `<article class="history-item"><div><strong>${item.result?.host || item.url || "Unknown site"}</strong><small>${new Date(item.startedAt).toLocaleString()} · ${item.status}</small></div><div class="history-actions"><button data-action="preview" data-job="${item.id}">Open preview</button><button data-action="folder" data-job="${item.id}">Open folder</button><button data-action="delete" data-job="${item.id}">Delete</button></div></article>`).join("") : "<p>No downloaded sites yet.</p>"; $("historyList").querySelectorAll("button").forEach((button) => { button.onclick = async () => { if (button.dataset.action === "delete") { if (!confirm("Delete this downloaded site and its files?")) return; await api.deleteMirror(button.dataset.job); await loadHistory(); } else if (button.dataset.action === "folder") await api.openPath(jobs.find((item) => item.id === button.dataset.job)?.result?.outputDir); else await api.openPreview(button.dataset.job); }; }); }
loadHistory();
