const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { assertConnection } = require("../desktop/connectivity");

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("a reachable target works offline from public services, even when HEAD is rejected", async (t) => {
  const url = await endpoint(t, (req, res) => { res.writeHead(405); res.end(); });
  await assertConnection({ url }, { probeUrls: ["http://unreachable.invalid"], timeout: 150 });
});

test("failed target and connectivity probes produce an actionable offline error", async (t) => {
  const url = await endpoint(t, (req) => req.socket.destroy());
  await assert.rejects(assertConnection({ url }, { probeUrls: [url, url], timeout: 150 }), {
    code: "NO_INTERNET",
    message: "No internet connection. Check your connection and try again.",
  });
});

test("one successful fallback distinguishes an inaccessible website from offline", async (t) => {
  const broken = await endpoint(t, (req) => req.socket.destroy());
  const online = await endpoint(t, (req, res) => res.end());
  await assert.rejects(assertConnection({ url: broken }, { probeUrls: [broken, online], timeout: 150 }), {
    code: "WEBSITE_UNREACHABLE",
    message: "Unable to reach this website. Check the URL and try again.",
  });
});

test("hanging connections time out instead of leaving the form checking forever", { timeout: 3000 }, async (t) => {
  const hanging = await endpoint(t, () => {});
  await assert.rejects(assertConnection({ url: hanging }, { probeUrls: [hanging], timeout: 100 }), { code: "NO_INTERNET" });
});

test("unreachable proxy is not mislabeled as offline and credentials are not exposed", async (t) => {
  const broken = await endpoint(t, (req) => req.socket.destroy());
  const proxyUrl = broken.replace("http://", "http://private-user:secret-password@");
  await assert.rejects(assertConnection({ url: "https://example.com", proxyUrl }, { probeUrls: ["https://example.com"], timeout: 150 }), {
    code: "PROXY_UNREACHABLE",
    message: "Unable to connect through the proxy. Check its address, port, credentials, and your connection.",
  });
});

test("proxy authentication failures are not accepted as internet connectivity", async (t) => {
  const { Server } = await import("proxy-chain");
  const proxy = new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction: () => ({ requestAuthentication: true }) });
  await proxy.listen();
  t.after(() => proxy.close(true));
  for (const url of ["http://example.com", "https://example.com"]) {
    await assert.rejects(assertConnection({ url, proxyUrl: `http://127.0.0.1:${proxy.port}` }, { probeUrls: [], timeout: 150 }), {
      code: "PROXY_AUTH_FAILED",
      message: "Proxy authentication failed. Check your username and password.",
    });
  }
});

test("a stalled proxy gets a timeout message rather than a website or offline error", { timeout: 3000 }, async (t) => {
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  proxy.on("connect", () => {});
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => proxy.close(resolve)); });
  await assert.rejects(assertConnection({ url: "http://example.com", proxyUrl: `http://127.0.0.1:${proxy.address().port}` }, { probeUrls: [], timeout: 100 }), {
    code: "PROXY_TIMEOUT",
    message: "The proxy connection timed out. Check the proxy address, port, and your connection, then try again.",
  });
});

test("invalid proxy configuration is reported without echoing its password", async () => {
  await assert.rejects(assertConnection({ url: "https://example.com", proxyUrl: "ftp://user:secret@proxy.example.com" }), {
    code: "INVALID_PROXY",
    message: "Enter a valid HTTP, HTTPS, SOCKS4, or SOCKS5 proxy address and port.",
  });
});

test("the selected authenticated proxy carries the target probe without direct DNS", async (t) => {
  const { Server } = await import("proxy-chain");
  const requests = [];
  const proxy = new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction: ({ request, username, password }) => {
    requests.push(request.url);
    return { requestAuthentication: username !== "user" || password !== "pass", customResponseFunction: () => ({ statusCode: 200, body: "online" }) };
  } });
  await proxy.listen();
  t.after(() => proxy.close(true));
  // These hosts cannot resolve directly: success must come from the selected proxy.
  await assertConnection({ url: "http://target.invalid", proxyUrl: `http://user:pass@127.0.0.1:${proxy.port}` }, { timeout: 1000 });
  assert.deepEqual(requests, ["http://target.invalid/"]);
});

test("SOCKS5 password rejection is identified for both HTTP and HTTPS targets", async (t) => {
  const net = require("node:net");
  const sockets = new Set();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let greeting = true;
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (greeting) {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return;
        pending = pending.subarray(2 + pending[1]);
        greeting = false;
        socket.write(Buffer.from([5, 2])); // Require username/password authentication.
      } else {
        if (pending.length < 2 || pending.length < 3 + pending[1]) return;
        if (pending.length < 3 + pending[1] + pending[2 + pending[1]]) return;
        socket.end(Buffer.from([1, 1])); // Credentials rejected.
      }
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => proxy.close(resolve)); });
  for (const url of ["http://example.com", "https://example.com"]) {
    await assert.rejects(assertConnection({ url, proxyUrl: `socks5://user:pass@127.0.0.1:${proxy.address().port}` }, { timeout: 500 }), { code: "PROXY_AUTH_FAILED" });
  }
});
