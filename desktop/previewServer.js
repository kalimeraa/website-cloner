const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };

function createPreviewServer() {
  const roots = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const parts = new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean);
      const root = roots.get(parts.shift()); if (!root) { res.writeHead(404); return res.end("Preview not found"); }
      const file = path.resolve(root, parts.join("/") || "index.html"); if (!file.startsWith(path.resolve(root))) { res.writeHead(403); return res.end("Forbidden"); }
      const data = await fs.readFile(file); res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" }); res.end(data);
    } catch (error) { res.writeHead(404); res.end("File not found"); }
  });
  let port;
  return { add: async (id, root, entry = "index.html") => { roots.set(id, root); if (!port) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); port = server.address().port; } return `http://127.0.0.1:${port}/${id}/${entry}`; }, close: () => server.close() };
}
module.exports = { createPreviewServer };
