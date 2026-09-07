const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("HTTP UI loads and rejected connection checks return errors, not running jobs", { timeout: 10000 }, async (t) => {
  const repo = path.resolve(__dirname, "..");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "website-cloner-http-"));
  for (const entry of ["serve.js", "desktop", "vendor"]) await fs.cp(path.join(repo, entry), path.join(scratch, entry), { recursive: true });
  await fs.symlink(path.join(repo, "node_modules"), path.join(scratch, "node_modules"), "junction");
  const child = spawn(process.execPath, [path.join(scratch, "serve.js")], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode !== null) return; child.kill(); return new Promise((resolve) => child.once("exit", resolve)); });
  const address = await new Promise((resolve, reject) => {
    child.once("error", reject);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    child.once("exit", () => reject(new Error("HTTP server stopped before listening")));
  });
  for (const resource of ["/", "/app.js", "/style.css", "/history.css"]) {
    assert.equal((await fetch(`${address}${resource}`)).status, 200, resource);
  }
  const response = await fetch(`${address}/api/mirror`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", proxyUrl: "ftp://private:secret@proxy.example.com", outputDir: path.join(scratch, "output") }),
  });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.code, "INVALID_PROXY");
  assert.match(result.error, /valid HTTP/);
  assert.equal(result.id, undefined);
  await assert.rejects(fs.stat(path.join(scratch, "output")), { code: "ENOENT" });
});
