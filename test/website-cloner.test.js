const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { defaultOutputDir, validateUrl } = require("../desktop/pathPolicy");
const { createJobStore } = require("../desktop/jobStore");

test("default output is grouped by domain and timestamp", () => {
  const output = defaultOutputDir("/Users/test/Documents", "www.example.com");
  assert.match(output, /Documents[\\/]Website Cloner[\\/]www\.example\.com[\\/]/);
});

test("URL validation accepts web URLs and rejects unsupported protocols", () => {
  assert.equal(validateUrl("https://example.com/path").hostname, "example.com");
  assert.throws(() => validateUrl("ftp://example.com"), /Only http/);
  assert.throws(() => validateUrl("not-a-url"), /valid URL/);
});

test("job store persists serializable job metadata without control secrets", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "website-cloner-"));
  const file = path.join(dir, "jobs.json");
  const store = createJobStore(file);
  await store.set({ id: "1", status: "completed", control: { stop: false }, result: { outputDir: "/tmp/site" } });
  const raw = await fs.readFile(file, "utf8");
  assert.doesNotMatch(raw, /control/);
  assert.equal(store.get("1").status, "completed");
});
