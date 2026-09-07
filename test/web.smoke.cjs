const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

(async () => {
  const { binaryInfo } = await import("cloakbrowser");
  const browser = await chromium.launch({ executablePath: binaryInfo().binaryPath, headless: true });
  try {
    const page = await browser.newPage();
    let starts = 0;
    let polls = 0;
    await page.route("http://website-cloner.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/mirror") {
        starts += 1;
        if (starts === 1) return route.fulfill({ status: 400, json: { code: "NO_INTERNET", error: "No internet connection. Check your connection and try again." } });
        return route.fulfill({ json: { id: `job-${starts}`, status: "running" } });
      }
      if (url.pathname.startsWith("/api/mirror/")) {
        polls += 1;
        if (polls === 1) return route.abort("connectionreset");
        if (starts === 3) return route.fulfill({ json: { status: "failed", error: "Capture failed. Please try again." } });
        return route.fulfill({ json: { status: "completed", result: { host: "example.com", pages: 1, files: 1, bytes: 100, outputDir: "/tmp/site", previewUrl: "/preview/job-2/index.html", challenge: "none" } } });
      }
      if (url.pathname.startsWith("/preview/")) return route.fulfill({ status: 404, body: "" });
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const contentType = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html";
      return route.fulfill({ contentType, body: await fs.readFile(path.join(__dirname, "../desktop/renderer", name)) });
    });
    await page.goto("http://website-cloner.test/");
    await page.locator("#url").fill("https://example.com");
    await page.getByRole("button", { name: "Start cloning", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Failed");
    assert.match(await page.locator('[role="alert"]').textContent(), /No internet connection/);
    assert.equal(await page.locator('button[type="submit"]').isEnabled(), true);
    await page.getByRole("button", { name: "Start cloning", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Reconnecting", null, { timeout: 4000 });
    assert.equal(await page.locator('button[type="submit"]').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__job.status), "running");
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Completed", null, { timeout: 4000 });
    assert.equal(await page.locator('[role="alert"]').textContent(), "");
    assert.equal(await page.locator('button[type="submit"]').isEnabled(), true);
    await page.getByRole("button", { name: "Start cloning", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Failed", null, { timeout: 4000 });
    assert.match(await page.locator('[role="alert"]').textContent(), /Capture failed/);
    assert.equal(await page.locator("#result").textContent(), "");
    assert.equal(await page.locator('button[type="submit"]').isEnabled(), true);
    console.log(JSON.stringify({ httpStartError: "passed", reconnect: "passed", secondCapture: "passed", terminalFailure: "passed", starts, polls }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
