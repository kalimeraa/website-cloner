const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

(async () => {
  const repo = path.resolve(__dirname, "..");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "website-cloner-connectivity-"));
  const snapshot = path.join(scratch, "app");
  await fs.mkdir(snapshot);
  for (const entry of ["desktop", "vendor", "build", "package.json"]) {
    await fs.cp(path.join(repo, entry), path.join(snapshot, entry), { recursive: true });
  }
  await fs.symlink(path.join(repo, "node_modules"), path.join(snapshot, "node_modules"), "junction");
  const application = await electron.launch({
    executablePath: require("electron"),
    args: [snapshot, `--user-data-dir=${path.join(scratch, "profile")}`],
    env: { ...process.env, CLOAKBROWSER_LOCALE: "en-US", CLOAKBROWSER_TIMEZONE: "UTC" },
  });
  const { Server } = await import("proxy-chain");
  const proxy = new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction: () => ({ requestAuthentication: true }) });
  await proxy.listen();
  try {
    const page = await application.firstWindow();
    const rendererErrors = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await application.evaluate(async ({ app }, scratchDir) => {
      const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
      const fs = require("node:fs/promises");
      await fs.mkdir(`${scratchDir}/Documents`);
      app.setPath("documents", `${scratchDir}/Documents`);
      const { request } = require(`${app.getAppPath()}/node_modules/playwright-core`);
      global.originalNewContext = request.newContext.bind(request);
      // Simulate lost internet at the network boundary, preserving real IPC/UI/service code.
      request.newContext = async (...args) => {
        const context = await global.originalNewContext(...args);
        context.head = async () => { await new Promise((resolve) => setTimeout(resolve, 250)); throw new Error("ENETUNREACH"); };
        return context;
      };
    }, scratch);

    await page.locator("#url").fill("https://example.com");
    await page.getByRole("button", { name: "Start cloning", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Checking", null, { timeout: 3000 });
    assert.equal(await page.locator('button[type="submit"]').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Failed", null, { timeout: 3000 });
    assert.match(await page.locator('[role="alert"]').textContent(), /No internet connection/);
    assert.equal(await page.locator('button[type="submit"]').isEnabled(), true);
    assert.equal((await page.evaluate(() => window.websiteCloner.listMirrors())).length, 0);

    await application.evaluate(({ app }) => {
      const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
      require(`${app.getAppPath()}/node_modules/playwright-core`).request.newContext = global.originalNewContext;
    });
    await page.locator("#protocol").selectOption("http");
    await page.locator("#host").fill("127.0.0.1");
    await page.locator("#port").fill(String(proxy.port));
    await page.locator("#username").fill("private-user");
    await page.locator("#password").fill("secret-password");
    await page.getByRole("button", { name: "Start cloning", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="alert"]').textContent.includes("Proxy authentication failed"));
    assert.doesNotMatch(await page.locator('[role="alert"]').textContent(), /private-user|secret-password/);
    assert.equal(await page.locator('button[type="submit"]').isEnabled(), true);
    assert.equal((await page.evaluate(() => window.websiteCloner.listMirrors())).length, 0);
    await page.screenshot({ path: path.join(scratch, "proxy-error.png"), fullPage: true });

    // Recover using a real example.com capture; no changes to the user's history or output.
    await page.locator("#protocol").selectOption("");
    await page.getByRole("button", { name: "Start cloning", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Completed", null, { timeout: 150000 });
    const jobs = await page.evaluate(() => window.websiteCloner.listMirrors());
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].result.pages, 1);
    assert.equal(await page.locator('button[type="submit"]').isEnabled(), true);
    assert.equal(await page.locator('[role="alert"]').textContent(), "");
    const response = await fetch(jobs[0].result.previewUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Example Domain/);
    assert.deepEqual(rendererErrors, []);
    console.log(JSON.stringify({ offline: "passed", proxyAuth: "passed", retryCapture: "passed", preview: response.status, scratch }));
  } finally {
    await application.close();
    await proxy.close(true);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
