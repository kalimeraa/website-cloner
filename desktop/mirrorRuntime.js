const fs = require("fs/promises");
const path = require("path");

// The crawler is vendored here so this repository remains self-contained.
function loadCrawler() { return require(path.resolve(__dirname, "../vendor/siteMirror.js")); }
async function runMirror(options) {
  const crawler = loadCrawler();
  const outputDir = path.resolve(options.outputDir); await fs.mkdir(outputDir, { recursive: true });
  const report = options.onProgress || (async () => {});
  const progressState = { phase: "running", visited: 0, queued: 1, maxPages: options.maxPages || 1, savedAssets: 0, bytes: 0, currentUrl: options.url };
  const onProgress = async (patch) => { Object.assign(progressState, patch); await report({ ...progressState }); };
  const onEvent = async (event, meta = {}) => {
    if (event === "site_mirror_assets_progress") {
      await onProgress({ phase: "running", savedAssets: meta.saved || 0, bytes: meta.bytes || 0 });
    }
  };
  await onProgress({ phase: "running", currentUrl: options.url, visited: 0, queued: 1, maxPages: options.maxPages || 1, savedAssets: 0, bytes: 0 });
  const result = await crawler.mirrorSite({ ...options, onProgress, onEvent });
  if (result.dir && result.dir !== outputDir) await fs.cp(result.dir, outputDir, { recursive: true, force: true });
  const screenshotPath = path.join(outputDir, "screenshot.png");
  try {
    const { launchBrowserContext } = require(path.resolve(__dirname, "../vendor/cloakBrowserClient.js"));
    const context = await launchBrowserContext({ headless: true, proxyUrl: options.proxyUrl });
    const page = await context.newPage(); await page.goto(result.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 30000 }); await context.close();
  } catch (error) { /* screenshot is best-effort; mirror remains usable */ }
  const manifest = { ...result, outputDir, screenshotPath, challenge: /challenge|captcha|sorry|blocked/i.test(`${result.startUrl} ${result.host}`) ? "challenge_detected" : "none" };
  await fs.writeFile(path.join(outputDir, "mirror-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"); return manifest;
}
module.exports = { runMirror };
