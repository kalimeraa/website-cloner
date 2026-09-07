const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { launchBrowserContext } = require("./cloakBrowserClient");

// Mirror çıktıları buraya yazılır: mock-sites/<site-slug>/<host>/...
const MOCK_SITES_ROOT = path.join(__dirname, "..", "..", "mock-sites");

// Çok büyük medya asset'lerini (video/ses veya bu eşiği aşan) indirmeyiz; mock site için gereksiz.
const DEFAULT_MAX_ASSET_BYTES = 20 * 1024 * 1024;

const TYPE_EXTENSION = {
  "text/html": ".html",
  "application/xhtml+xml": ".html",
  "text/css": ".css",
  "application/javascript": ".js",
  "text/javascript": ".js",
  "application/json": ".json",
  "application/manifest+json": ".webmanifest",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "application/font-woff2": ".woff2",
  "application/font-woff": ".woff"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentTypeBase(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

function extensionFor(contentType, fallbackExtension) {
  const base = contentTypeBase(contentType);
  if (TYPE_EXTENSION[base]) return TYPE_EXTENSION[base];
  return fallbackExtension ? `.${fallbackExtension.replace(/^\./, "")}` : "";
}

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 8);
}

function slugifyRoot(host) {
  return String(host || "site")
    .replace(/^www\./i, "")
    .replace(/[^a-z0-9.-]/gi, "_")
    .slice(0, 80) || "site";
}

function normalizeStartUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("url is required");
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(withProtocol).toString();
}

// Fragment'i at, root dışındaki trailing slash'i normalize et. Aynı kaynağın farklı yazımlarını
// tek anahtara indirger → capture map ile referans rewrite'ı tutarlı eşleşsin.
function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch (error) {
    return null;
  }
}

function resolveUrl(reference, baseUrl) {
  const trimmed = String(reference || "").trim();
  if (!trimmed) return null;
  if (/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch (error) {
    return null;
  }
}

function baseDomain(host) {
  const parts = String(host || "").split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}

function sameSite(url, rootHost) {
  try {
    return baseDomain(new URL(url).hostname) === baseDomain(rootHost);
  } catch (error) {
    return false;
  }
}

function sanitizeSegment(segment) {
  const cleaned = String(segment || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120);
  return cleaned || "_";
}

// Bir URL'i disk üzerindeki göreli yola (root'a göre, "/" ayraçlı) çevirir.
// Uzantısı olmayan/dizin biten yollar <path>/index.<ext> olur → offline'da klasör indexi gibi açılır.
function assetLocalPath(rawUrl, contentType) {
  const url = new URL(rawUrl);
  const host = sanitizeSegment(url.hostname);
  const pathname = decodeURIComponent(url.pathname);
  const segments = pathname.split("/").filter(Boolean).map(sanitizeSegment);
  const lastSegment = segments[segments.length - 1];
  const looksLikeFile = Boolean(lastSegment) && /\.[a-z0-9]{1,8}$/i.test(lastSegment);

  let fileName;
  if (pathname.endsWith("/") || !looksLikeFile) {
    fileName = `index${extensionFor(contentType, "html")}`;
  } else {
    fileName = segments.pop();
  }

  // Query string'i dosya adına hash olarak göm → aynı path'in farklı query'leri çakışmasın.
  if (url.search) {
    const suffix = `_${shortHash(url.search)}`;
    const dot = fileName.lastIndexOf(".");
    fileName = dot > 0 ? `${fileName.slice(0, dot)}${suffix}${fileName.slice(dot)}` : `${fileName}${suffix}`;
  }

  return [host, ...segments, fileName].join("/");
}

function relativePath(fromRel, toRel) {
  const rel = path.posix.relative(path.posix.dirname(fromRel), toRel);
  return rel || path.posix.basename(toRel);
}

async function writeFileRel(outDir, rel, buffer) {
  const fullPath = path.join(outDir, ...rel.split("/"));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
  return fullPath;
}

// HTML/CSS metnindeki URL taşıyan referansları, yakalanmış asset'lerin local göreli yoluna çevirir.
// Yakalanmayan referanslar absolute kalır (online iken yine yüklensin).
function rewriteReferences(text, baseUrl, currentRel, urlToRel) {
  const toLocal = (reference) => {
    const absolute = resolveUrl(reference, baseUrl);
    if (!absolute) return null;
    const key = canonicalUrl(absolute);
    const rel = key && urlToRel.get(key);
    if (!rel) return null;
    return relativePath(currentRel, rel);
  };

  const rewriteAttr = (attr, value, quote) => {
    const rel = toLocal(value);
    return rel ? `${attr}=${quote}${rel}${quote}` : null;
  };

  let output = text.replace(
    /\b(href|src|poster|data-src|data-lazy-src|data-original)\s*=\s*"([^"]*)"/gi,
    (match, attr, value) => rewriteAttr(attr, value, '"') || match
  );
  output = output.replace(
    /\b(href|src|poster|data-src|data-lazy-src|data-original)\s*=\s*'([^']*)'/gi,
    (match, attr, value) => rewriteAttr(attr, value, "'") || match
  );

  const rewriteSrcset = (value) => value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const pieces = trimmed.split(/\s+/);
      const rel = toLocal(pieces[0]);
      if (rel) pieces[0] = rel;
      return pieces.join(" ");
    })
    .join(", ");

  output = output.replace(/\bsrcset\s*=\s*"([^"]*)"/gi, (match, value) => `srcset="${rewriteSrcset(value)}"`);
  output = output.replace(/\bsrcset\s*=\s*'([^']*)'/gi, (match, value) => `srcset='${rewriteSrcset(value)}'`);

  output = output.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, value) => {
    const rel = toLocal(value);
    return rel ? `url(${quote}${rel}${quote})` : match;
  });

  return output;
}

// Cloudflare bot-koruma ve Google/analytics tracking referansları. Bunlar (a) indirilmez,
// (b) kaydedilen HTML'den script olarak çıkarılır. Sebep: Cloudflare'in challenge scripti
// mirror'lanan sayfayı offline'da "about:blank"e yönlendirip boş bırakıyor.
function isTrackingRef(ref) {
  return /googletagmanager\.com|google-analytics\.com|googlesyndication\.com|googleadservices|doubleclick\.net|\/gtag\/|challenges\.cloudflare\.com|cloudflareinsights\.com|\/cdn-cgi\//i
    .test(String(ref || ""));
}

// Kaydedilen HTML'den tracking/cloudflare script'lerini ve about:blank self-redirect'ini çıkarır.
// Gövde markup'ı (render edilmiş içerik) korunur → sayfa statik snapshot olarak görüntülenir.
function sanitizeDocumentHtml(html) {
  // src'li tracking/cloudflare script'leri.
  let out = html.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>\s*<\/script>/gi, (match, quote, src) => {
    return isTrackingRef(src) ? "" : match;
  });

  // Inline script'ler: cloudflare challenge / tracking / about:blank yönlendirmesi içerenleri sil.
  out = out.replace(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi, (match, body) => {
    if (/__CF\$cv\$params|_cf_chl|cf-beacon|cloudflareinsights|rocket-loader|about:blank|\bgtag\s*\(|\bdataLayer\b|google-analytics|googletagmanager/i.test(body)) {
      return "";
    }
    return match;
  });

  // Cloudflare/Google doğrulama meta tag'leri.
  out = out.replace(/<meta\b[^>]*\b(?:name\s*=\s*["']google-site-verification["']|http-equiv\s*=\s*["']cf-[^"']*["'])[^>]*>/gi, "");

  return out;
}

// Site'ın JS'i strip edildiği için popup/modal'ların kendi kapatma butonları çalışmaz.
// Bu küçük bağımsız script mirror'a enjekte edilir: bir "kapat/close/×" öğesine tıklayınca
// (veya Escape'e basınca) en yakın modal/overlay/popup atasını gizler. Framework gerektirmez.
const POPUP_DISMISSER = `<script data-site-mirror-dismisser="1">
(function(){
  var KEY="sm_dismissed_popups";
  var W=function(){return window.innerWidth;},H=function(){return window.innerHeight;};
  function clsOf(n){return ((n.className&&n.className.toString?n.className.toString():"")+" "+(n.id||""));}
  function named(n){var r=(n.getAttribute&&n.getAttribute("role"))||"";return r==="dialog"||/modal|popup|overlay|backdrop|lightbox|dialog|promo|notification|swal|fancybox|mfp/i.test(clsOf(n));}
  function overlayLike(n){try{var s=getComputedStyle(n);if(s.position!=="fixed"&&s.position!=="absolute")return false;return n.offsetWidth>=W()*0.5&&n.offsetHeight>=H()*0.3;}catch(e){return false;}}
  function readList(){try{return JSON.parse(localStorage.getItem(KEY)||"[]");}catch(e){return [];}}
  function saveList(l){try{localStorage.setItem(KEY,JSON.stringify(l.slice(-80)));}catch(e){}}
  // Popup'ın kalıcı imzası: başlık metni (h1/h2/header) → sayfalar arası aynı promo için stabil.
  function sigOf(el){
    var h=el.querySelector&&el.querySelector("h1,h2,h3,header");
    var t=((h&&h.textContent)||el.textContent||"").replace(/\\s+/g," ").trim().slice(0,80);
    return t||clsOf(el).replace(/\\s+/g," ").trim().slice(0,80);
  }
  function remember(el){var l=readList();var s=sigOf(el);if(s&&l.indexOf(s)<0){l.push(s);saveList(l);}}
  // Tıklanan kapat butonundan yukarı çık; BUTONU değil, EN DIŞTAKI modal/overlay/backdrop atasını gizle.
  function hideModalAround(el){
    var best=null,n=el,depth=0;
    while(n&&n!==document.body&&depth<14){try{if(named(n)||overlayLike(n))best=n;}catch(e){}n=n.parentElement;depth++;}
    if(best){remember(best);best.style.display="none";
      try{var p=best.parentElement;if(p){Array.prototype.forEach.call(p.children,function(c){if(c!==best&&/backdrop|overlay|mask/i.test(clsOf(c)))c.style.display="none";});}}catch(e){}
      return true;}
    return false;
  }
  function isCloseEl(n){
    var cls=clsOf(n);var al=(n.getAttribute?(n.getAttribute("aria-label")||""):"");var txt=(n.textContent||"").trim();
    return /(^|[^a-z])close([^a-z]|$)|kapat|dismiss|reddet|btn-close|modal-close|popup-close/i.test(cls+" "+al)||txt==="×"||txt==="✕"||txt==="✖"||txt==="X"||txt==="x";
  }
  document.addEventListener("click",function(e){
    var p=e.target;
    for(var i=0;i<5&&p&&p!==document.body;i++){if(isCloseEl(p)){if(hideModalAround(p)){e.preventDefault();e.stopPropagation();return;}}p=p.parentElement;}
  },true);
  function candidates(){return document.querySelectorAll("[role=dialog],[class*=modal],[class*=popup],[class*=overlay],[class*=backdrop],[class*=lightbox],[class*=notification],[class*=promo]");}
  function hideTopmostOverlay(){
    var best=null;
    Array.prototype.forEach.call(candidates(),function(n){try{var s=getComputedStyle(n);if(s.display==="none"||s.visibility==="hidden")return;if(overlayLike(n)||named(n))best=n;}catch(e){}});
    if(best){remember(best);best.style.display="none";return true;}return false;
  }
  document.addEventListener("keydown",function(e){if(e.key==="Escape"||e.keyCode===27)hideTopmostOverlay();});
  // SAYFA YÜKLENİNCE: daha önce kapatılmış popup'ları (imza eşleşiyorsa) otomatik gizle → "bir daha gelmesin".
  function autoHide(){
    var l=readList();if(!l.length)return;
    Array.prototype.forEach.call(candidates(),function(n){try{var s=getComputedStyle(n);if(s.display==="none"||s.visibility==="hidden")return;if(!(overlayLike(n)||named(n)))return;if(l.indexOf(sigOf(n))>=0)n.style.display="none";}catch(e){}});
  }
  if(document.readyState!=="loading")autoHide();else document.addEventListener("DOMContentLoaded",autoHide);
  setTimeout(autoHide,300);setTimeout(autoHide,1200);
})();
</script>`;

function injectPopupDismisser(html) {
  // Eski dismisser'ı (varsa) çıkar ki her uygulamada güncel sürüm yazılsın.
  const cleaned = html.replace(/<script data-site-mirror-dismisser="1">[\s\S]*?<\/script>/gi, "");
  if (/<\/body>/i.test(cleaned)) return cleaned.replace(/<\/body>/i, `${POPUP_DISMISSER}</body>`);
  return cleaned + POPUP_DISMISSER;
}

// Her yakalanan asset'i ANINDA diske yazar ve buffer'ı bellekte tutmaz.
// Böylece dosyalar crawl sürerken canlı olarak mock-sites'a düşer ve bellek şişmez.
// HTML dokümanları burada da (raw) yazılır; sonda render+rewrite edilmiş halleriyle üzerine yazılır.
async function captureAndSaveResponse(response, ctx) {
  const url = response.url();
  if (!/^https?:/i.test(url)) return;

  // Cloudflare/Google tracking asset'lerini indirme (istenirse).
  if (ctx.stripTracking && isTrackingRef(url)) return;

  const key = canonicalUrl(url);
  if (!key || ctx.store.has(key)) return;

  const status = response.status();
  if (status >= 300 && status < 400) return;

  const headers = response.headers();
  const base = contentTypeBase(headers["content-type"]);
  if (base.startsWith("video/") || base.startsWith("audio/")) return;

  let buffer;
  try {
    buffer = await response.body();
  } catch (error) {
    return;
  }
  if (!buffer || !buffer.length || buffer.length > ctx.maxAssetBytes) return;

  // await sonrası tekrar kontrol: aynı URL için başka handler önce bitmiş olabilir (çift yazma önlenir).
  if (ctx.store.has(key)) return;

  const contentType = headers["content-type"] || "";
  const rel = assetLocalPath(url, contentType);
  ctx.store.set(key, { url, contentType, rel });
  ctx.urlToRel.set(key, rel);

  try {
    await writeFileRel(ctx.outDir, rel, buffer);
    ctx.counters.writtenRels.add(rel);
    ctx.counters.bytes += buffer.length;
    ctx.counters.assets += 1;
    if (ctx.counters.assets % 25 === 0) {
      await ctx.onEvent("site_mirror_assets_progress", { saved: ctx.counters.assets, bytes: ctx.counters.bytes });
    }
  } catch (error) {
    await ctx.onEvent("site_mirror_asset_write_failed", { url, error: error.message });
  }
}

function extractLinks(page) {
  return page
    .evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((anchor) => anchor.href).filter(Boolean))
    .catch(() => []);
}

// Hedefe gidildikten sonra doğal bekleme + aşağı/yukarı scroll (lazy-load asset'leri tetikler).
async function settleAndScroll(page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const steps = 4;
  for (let i = 0; i < steps; i += 1) {
    const fraction = (i + 1) / steps;
    await page
      .evaluate((f) => {
        const height = document.body ? document.body.scrollHeight : 2000;
        window.scrollTo(0, Math.floor(height * f));
      }, fraction)
      .catch(() => {});
    await sleep(400 + Math.floor(Math.random() * 500));
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
}

// Asset'ler crawl sırasında zaten diske yazıldı. Burada sadece: (1) CSS dosyalarındaki url()
// referanslarını local yola çevir (diskten oku → üstüne yaz), (2) gezilen sayfaların render edilmiş
// HTML'ini rewrite edip yaz, (3) manifest. urlToRel crawl boyunca dolduruldu.
async function finalizeMirror({ outDir, host, store, documents, urlToRel, counters, stripTracking, onEvent }) {
  // Gezilen sayfalar için render edilmiş HTML rel'i (network raw HTML'ini ezer).
  for (const [key, doc] of documents) {
    urlToRel.set(key, assetLocalPath(doc.baseUrl, "text/html"));
  }

  // İlk gezilen sayfa = serve girişi.
  const firstDocKey = documents.keys().next().value;
  const entry = firstDocKey ? urlToRel.get(firstDocKey) : null;

  // CSS rewrite pass — diskteki her CSS'i oku, url()'leri local yola çevir, geri yaz.
  for (const [key, item] of store) {
    if (documents.has(key)) continue;
    if (contentTypeBase(item.contentType) !== "text/css") continue;
    const fullPath = path.join(outDir, ...item.rel.split("/"));
    try {
      const css = await fs.readFile(fullPath, "utf8");
      const rewritten = rewriteReferences(css, item.url, item.rel, urlToRel);
      if (rewritten !== css) await fs.writeFile(fullPath, rewritten);
    } catch (error) {
      // CSS okunamadıysa raw hali kalır
    }
  }

  // Gezilen sayfaların render edilmiş HTML'ini (varsa tracking/cloudflare temizliği →) rewrite edip yaz.
  for (const [key, doc] of documents) {
    const rel = urlToRel.get(key);
    let cleaned = stripTracking ? sanitizeDocumentHtml(doc.html) : doc.html;
    if (stripTracking) cleaned = injectPopupDismisser(cleaned);
    const html = rewriteReferences(cleaned, doc.baseUrl, rel, urlToRel);
    await writeFileRel(outDir, rel, Buffer.from(html, "utf8"));
    counters.writtenRels.add(rel);
  }

  const files = counters.writtenRels.size;
  const manifest = {
    generatedAt: new Date().toISOString(),
    host,
    entry,
    documents: Array.from(documents.values()).map((doc) => doc.baseUrl),
    counts: { files, assets: counters.assets, documents: documents.size },
    bytes: counters.bytes
  };
  await writeFileRel(outDir, "mirror-manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));

  await onEvent("site_mirror_written", { dir: outDir, files, assets: counters.assets, documents: documents.size, bytes: counters.bytes });
  return { files, assets: counters.assets, documents: documents.size, bytes: counters.bytes, entry };
}

async function mirrorSite(options = {}) {
  const {
    url,
    proxyUrl,
    maxDepth = 2,
    maxPages = 25,
    headless = true,
    deviceMode = "desktop",
    sameHostOnly = true,
    maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
    stripTracking = true,
    onEvent = async () => {},
    // Duraklat/durdur kontrolü: dışarıdan mutasyona uğratılan bir obje. pause=true iken döngü bekler
    // (tarayıcı + tüm state açık kalır → kaldığın yerden devam). stop=true iken döngü kırılır ve
    // o ana kadar toplananlar finalize edilir (kısmi mirror yine gezilebilir).
    control = { pause: false, stop: false },
    onProgress = async () => {}
  } = options;

  const startUrl = normalizeStartUrl(url);
  const rootHost = new URL(startUrl).hostname;
  const rootSlug = slugifyRoot(rootHost);
  const outDir = path.join(MOCK_SITES_ROOT, rootSlug);

  const store = new Map();
  const documents = new Map();
  const urlToRel = new Map();
  const counters = { assets: 0, bytes: 0, writtenRels: new Set() };
  const pendingCaptures = new Set();
  const ctx = { store, urlToRel, counters, outDir, maxAssetBytes, stripTracking, onEvent };

  await onEvent("site_mirror_context_start", { url: startUrl, headless, proxied: Boolean(proxyUrl) });
  const context = await launchBrowserContext({ headless, deviceMode, proxyUrl });
  context.on("response", (response) => {
    const pending = captureAndSaveResponse(response, ctx).catch(() => {});
    pendingCaptures.add(pending);
    pending.finally(() => pendingCaptures.delete(pending)).catch(() => {});
  });

  const visited = new Set();
  const queue = [{ url: canonicalUrl(startUrl) || startUrl, depth: 0 }];
  const pages = [];

  const reportProgress = async (extra = {}) => {
    await onProgress({
      visited: visited.size,
      queued: queue.length,
      maxPages,
      savedAssets: counters.assets,
      bytes: counters.bytes,
      ...extra
    });
  };

  try {
    while (queue.length && visited.size < maxPages) {
      if (control.stop) break;

      // Duraklama kapısı: pause kalkana (veya stop gelene) kadar bekle. Tarayıcı açık kalır.
      if (control.pause) {
        await reportProgress({ phase: "paused" });
        while (control.pause && !control.stop) {
          await sleep(300);
        }
        if (control.stop) break;
        await reportProgress({ phase: "running" });
      }

      const { url: pageUrl, depth } = queue.shift();
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);

      const page = await context.newPage();
      try {
        await onEvent("site_mirror_page_started", { url: pageUrl, depth });
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        await settleAndScroll(page);

        const html = await page.content().catch(() => "");
        const baseUrl = page.url();
        documents.set(canonicalUrl(baseUrl) || pageUrl, { html, baseUrl });
        pages.push({ url: baseUrl, depth });

        if (depth < maxDepth) {
          const links = await extractLinks(page);
          for (const link of links) {
            const canonical = canonicalUrl(link);
            if (!canonical) continue;
            if (sameHostOnly && !sameSite(canonical, rootHost)) continue;
            if (visited.has(canonical)) continue;
            if (queue.some((item) => item.url === canonical)) continue;
            queue.push({ url: canonical, depth: depth + 1 });
          }
        }

        await onEvent("site_mirror_page_visited", { url: baseUrl, depth, queued: queue.length, savedAssets: counters.assets });
        await reportProgress({ phase: "running", currentUrl: baseUrl, depth });
      } catch (error) {
        await onEvent("site_mirror_page_failed", { url: pageUrl, depth, error: error.message });
      } finally {
        await page.close().catch(() => {});
      }
    }

    // Geç gelen response'lar diske düşsün diye kısa bir soluk.
    await sleep(600);
    while (pendingCaptures.size) await Promise.all(Array.from(pendingCaptures));
    const summary = await finalizeMirror({ outDir, host: rootHost, store, documents, urlToRel, counters, stripTracking, onEvent });
    await reportProgress({ phase: control.stop ? "stopped" : "completed" });

    return {
      root: rootSlug,
      host: rootHost,
      dir: outDir,
      startUrl,
      stopped: Boolean(control.stop),
      pages: pages.length,
      pageUrls: pages.map((item) => item.url),
      serveUrl: `/api/site-mirror/serve/${rootSlug}/`,
      downloadUrl: `/api/site-mirror/${rootSlug}/download`,
      ...summary
    };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = {
  MOCK_SITES_ROOT,
  mirrorSite,
  // test/yeniden kullanım için saf yardımcılar
  assetLocalPath,
  canonicalUrl,
  rewriteReferences,
  sanitizeDocumentHtml,
  injectPopupDismisser,
  isTrackingRef,
  slugifyRoot
};
