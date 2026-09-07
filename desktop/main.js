const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const JSZip = require("jszip");
const { defaultOutputDir, validateUrl } = require("./pathPolicy");
const { createJobStore } = require("./jobStore");
const { createPreviewServer } = require("./previewServer");
const { runMirror } = require("./mirrorRuntime");
const { assertConnection } = require("./connectivity");

let win; let store; const preview = createPreviewServer();
app.setName("Website Cloner");
function createWindow() { win = new BrowserWindow({ width: 1180, height: 820, minWidth: 800, minHeight: 600, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false } }); win.loadFile(path.join(__dirname, "renderer/index.html")); }
async function zipDirectory(dir) { const zip = new JSZip(); async function walk(current, relative) { for (const entry of await fs.readdir(current, { withFileTypes: true })) { const full = path.join(current, entry.name); const rel = path.join(relative, entry.name); if (entry.isDirectory()) await walk(full, rel); else zip.file(rel, await fs.readFile(full)); } } await walk(dir, ""); return zip.generateAsync({ type: "nodebuffer" }); }
app.whenReady().then(async () => {
  store = createJobStore(path.join(app.getPath("userData"), "jobs.json")); await store.load(); createWindow();
  ipcMain.handle("choose-output-dir", async () => (await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })).filePaths[0] || "");
  ipcMain.handle("list-mirrors", () => store.list());
  ipcMain.handle("delete-mirror", async (_e, id) => { const job = store.get(id); if (!job) return false; if (job.result?.outputDir) await fs.rm(job.result.outputDir, { recursive: true, force: true }); store.delete(id); await store.persist(); return true; });
  ipcMain.handle("open-path", (_e, value) => shell.openPath(path.resolve(value)));
  ipcMain.handle("open-preview", async (_e, id) => { const job = store.get(id); if (!job?.result?.outputDir) throw new Error("Mirror output not found"); const entry = job.result.entry || "index.html"; const url = await preview.add(id, job.result.outputDir, entry); job.result.previewUrl = url; await store.set(job); await shell.openExternal(url); return url; });
  ipcMain.handle("export-zip", async (_e, id) => { const job = store.get(id); if (!job?.result?.outputDir) throw new Error("Mirror output not found"); const target = path.join(job.result.outputDir, `${job.result.host || "website"}.zip`); await fs.writeFile(target, await zipDirectory(job.result.outputDir)); return target; });
  ipcMain.handle("start-mirror", async (_e, payload) => {
    try { await assertConnection(payload); }
    catch (error) { return { error: error.message, code: error.code || "CONNECTION_CHECK_FAILED" }; }
    const host = validateUrl(payload.url).hostname; const outputDir = payload.outputDir || defaultOutputDir(app.getPath("documents"), host); const job = { id: `mirror_${Date.now()}`, ...payload, outputDir, status: "running", startedAt: new Date().toISOString(), control: { stop: false } }; await store.set(job);
  runMirror({ ...payload, outputDir, control: job.control, onProgress: async (progress) => win.webContents.send("mirror-progress", { id: job.id, ...progress }) }).then(async (result) => { result.previewUrl = await preview.add(job.id, result.outputDir, result.entry || "index.html"); job.result = result; job.status = "completed"; await store.set(job); win.webContents.send("mirror-progress", { id: job.id, status: job.status, result }); }).catch(async (error) => { job.status = "failed"; job.error = error.message; await store.set(job); win.webContents.send("mirror-progress", { id: job.id, status: job.status, error: job.error }); }); return job;
  });
});
app.on("window-all-closed", () => { preview.close(); if (process.platform !== "darwin") app.quit(); });
