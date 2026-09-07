const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { runMirror } = require("./desktop/mirrorRuntime");
const { defaultOutputDir } = require("./desktop/pathPolicy");
const { validateUrl } = require("./desktop/pathPolicy");
const { assertConnection } = require("./desktop/connectivity");

const root = __dirname;
const jobs = new Map();
const port = Number(process.env.PORT || 4173);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json" };
function send(res, status, body, type = "application/json") { res.writeHead(status, { "content-type": type }); res.end(type.startsWith("application/json") ? JSON.stringify(body) : body); }
function body(req) { return new Promise((resolve, reject) => { let text = ""; req.on("data", (chunk) => { text += chunk; if (text.length > 1000000) reject(new Error("Payload too large")); }); req.on("end", () => { try { resolve(JSON.parse(text || "{}")); } catch (error) { reject(error); } }); req.on("error", reject); }); }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/mirror") {
      const payload = await body(req); await assertConnection(payload); const host = validateUrl(payload.url).hostname; const id = `mirror_${Date.now()}`; const outputDir = payload.outputDir || defaultOutputDir(require("os").homedir() + "/Documents", host); const job = { id, status: "running", outputDir, progress: {} }; jobs.set(id, job); send(res, 202, job);
      runMirror({ ...payload, outputDir, onProgress: async (progress) => { job.progress = progress; } }).then((result) => { job.status = "completed"; job.result = { ...result, previewUrl: `/preview/${id}/${result.entry || "index.html"}` }; }).catch((error) => { job.status = "failed"; job.error = error.message; }); return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/mirror/")) { const job = jobs.get(url.pathname.split("/").pop()); if (!job) return send(res, 404, { error: "Not found" }); return send(res, 200, job); }
    if (req.method === "GET" && url.pathname.startsWith("/preview/")) { const parts = url.pathname.split("/").filter(Boolean); const job = jobs.get(parts[1]); if (!job?.result?.outputDir) return send(res, 404, { error: "Preview not ready" }); const previewFile = path.resolve(job.result.outputDir, parts.slice(2).join("/") || job.result.entry || "index.html"); if (!previewFile.startsWith(path.resolve(job.result.outputDir))) return send(res, 403, { error: "Forbidden" }); const data = await fs.readFile(previewFile); return send(res, 200, data, mime[path.extname(previewFile)] || "application/octet-stream"); }
    const rendererRoot = path.join(root, "desktop/renderer");
    const relative = url.pathname === "/" ? "/index.html" : url.pathname.replace(/^\/desktop\/renderer\//, "/");
    const file = path.resolve(rendererRoot, `.${relative}`);
    if (!file.startsWith(`${rendererRoot}${path.sep}`)) return send(res, 403, { error: "Forbidden" });
    send(res, 200, await fs.readFile(file), mime[path.extname(file)] || "application/octet-stream");
  } catch (error) { send(res, error.code === "ENOENT" ? 404 : 400, { error: error.message, code: error.code }); }
});
server.listen(port, "127.0.0.1", () => console.log(`Website Cloner HTTP server: http://127.0.0.1:${server.address().port}`));
