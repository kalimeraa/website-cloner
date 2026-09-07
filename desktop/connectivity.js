const { request } = require("playwright-core");
const http = require("node:http");
const https = require("node:https");
const { validateUrl } = require("./pathPolicy");

const PROBE_URLS = ["https://example.com/", "https://www.microsoft.com/"];
const MESSAGES = {
  NO_INTERNET: "No internet connection. Check your connection and try again.",
  WEBSITE_UNREACHABLE: "Unable to reach this website. Check the URL and try again.",
  PROXY_UNREACHABLE: "Unable to connect through the proxy. Check its address, port, credentials, and your connection.",
  PROXY_AUTH_FAILED: "Proxy authentication failed. Check your username and password.",
  PROXY_TIMEOUT: "The proxy connection timed out. Check the proxy address, port, and your connection, then try again.",
  INVALID_PROXY: "Enter a valid HTTP, HTTPS, SOCKS4, or SOCKS5 proxy address and port.",
};

function connectionError(code) {
  return Object.assign(new Error(MESSAGES[code]), { code });
}

function headThroughHttpProxy(address, proxyUrl, timeout) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const headers = { host: new URL(address).host };
    if (proxy.username || proxy.password) {
      headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    }
    const client = proxy.protocol === "https:" ? https : http;
    const req = client.request(proxy.origin, { path: address, method: "HEAD", headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    const timer = setTimeout(() => req.destroy(new Error("Connection timed out")), timeout);
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

async function assertConnection({ url, proxyUrl }, { probeUrls = PROBE_URLS, timeout = 5000 } = {}) {
  const target = validateUrl(url).href;
  if (proxyUrl) {
    try {
      const proxy = new URL(proxyUrl);
      if (!["http:", "https:", "socks4:", "socks5:"].includes(proxy.protocol) || !proxy.hostname
          || (["socks4:", "socks5:"].includes(proxy.protocol) && !proxy.port)) throw new Error();
    } catch {
      throw connectionError("INVALID_PROXY");
    }
  }

  let bridge;
  let context;
  const failures = new Set();
  const recordProxyStatus = (status) => {
    if ([401, 407, 597].includes(status)) failures.add("PROXY_AUTH_FAILED");
    if (status === 504) failures.add("PROXY_TIMEOUT");
  };
  try {
    if (proxyUrl) {
      // Forward every probe through the selected proxy, including SOCKS authentication.
      // Never fall back to a direct connection and never expose credentials in errors.
      const { Server } = await import("proxy-chain");
      bridge = new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction: () => ({ upstreamProxyUrl: proxyUrl }) });
      bridge.on("tunnelConnectFailed", ({ response }) => recordProxyStatus(response.statusCode));
      await bridge.listen();
    }
    context = await request.newContext({ proxy: bridge ? { server: `http://127.0.0.1:${bridge.port}` } : undefined });
    const probe = async (address) => {
      try {
        let status;
        if (bridge && /^https?:/.test(proxyUrl) && address.startsWith("http:")) {
          // Ordinary HTTP proxies may permit forwarding but reject CONNECT to port 80.
          status = await headThroughHttpProxy(address, proxyUrl, timeout);
        } else {
          const response = await context.head(address, { timeout, maxRedirects: 0, failOnStatusCode: false });
          status = response.status();
          await response.dispose();
        }
        if (bridge) recordProxyStatus(status === 401 ? 0 : status);
        // 403/404/405 still prove connectivity. Proxy errors do not.
        return !(bridge && (status === 407 || status === 504 || status >= 590));
      } catch (error) {
        if (bridge && /timeout|timed out/i.test(error.message)) failures.add("PROXY_TIMEOUT");
        if (bridge && /597|Socks5 Authentication failed/i.test(error.message)) failures.add("PROXY_AUTH_FAILED");
        return false;
      }
    };
    if (await probe(target)) return;
    if (failures.has("PROXY_AUTH_FAILED")) throw connectionError("PROXY_AUTH_FAILED");

    // Public checks are only needed if the target failed. One response is enough;
    // a blocked or down probe must not make a working connection look offline.
    const online = await Promise.any(probeUrls.map(async (address) => {
      if (!await probe(address)) throw new Error("Probe unavailable");
      return true;
    })).catch(() => false);
    const proxyCode = ["PROXY_AUTH_FAILED", "PROXY_TIMEOUT"].find((code) => failures.has(code)) || "PROXY_UNREACHABLE";
    throw connectionError(online ? "WEBSITE_UNREACHABLE" : proxyUrl ? proxyCode : "NO_INTERNET");
  } finally {
    // Disposing also cancels any slower fallback probe after another succeeds.
    try { if (context) await context.dispose(); }
    finally { if (bridge) await bridge.close(true); }
  }
}

module.exports = { assertConnection };
