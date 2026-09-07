const path = require("path");
const { cloakBrowser } = require("./config");

// Hesap-başına kalıcı profil kökü. Her Gmail hesabı kendi izole profilini (cookie/history/fingerprint)
// burada tutar → Google için "hep aynı cihaz" = güven. Tek paylaşımlı profil cross-contamination yapar.
const PROFILES_ROOT = path.join(__dirname, "..", "storage", "profiles");

function profileDirFor(profileKey) {
  const safe = String(profileKey || "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  return safe ? path.join(PROFILES_ROOT, safe) : "";
}

const DEFAULT_VIEWPORT = { width: 800, height: 600 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const MOBILE_USER_AGENT = "";

// Tüm CloakBrowser açılışları İstanbul/Türkiye kimliğiyle başlar; konum her açılışta random setlenir.
const ISTANBUL_TIMEZONE = "Europe/Istanbul";
const ISTANBUL_LOCALE = "tr-TR";
const ISTANBUL_GEO_BOUNDS = {
  minLatitude: 40.90,
  maxLatitude: 41.10,
  minLongitude: 28.75,
  maxLongitude: 29.25
};

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function randomIstanbulGeolocation() {
  return {
    latitude: Number(randomInRange(ISTANBUL_GEO_BOUNDS.minLatitude, ISTANBUL_GEO_BOUNDS.maxLatitude).toFixed(6)),
    longitude: Number(randomInRange(ISTANBUL_GEO_BOUNDS.minLongitude, ISTANBUL_GEO_BOUNDS.maxLongitude).toFixed(6)),
    accuracy: Math.floor(randomInRange(20, 100))
  };
}
const DEFAULT_CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage"
];

async function loadCloakBrowser() {
  return import("cloakbrowser");
}

async function loadProxyChain() {
  return import("proxy-chain");
}

function hasProxyCredentials(proxyUrl) {
  if (!proxyUrl) return false;

  try {
    return Boolean(new URL(proxyUrl).username);
  } catch (error) {
    return false;
  }
}

async function anonymizeProxyIfNeeded(proxyUrl) {
  if (!hasProxyCredentials(proxyUrl)) {
    return { proxyUrl, close: async () => {} };
  }

  const { anonymizeProxy, closeAnonymizedProxy } = await loadProxyChain();
  const anonymizedProxyUrl = await anonymizeProxy(proxyUrl);
  return {
    proxyUrl: anonymizedProxyUrl,
    close: async () => {
      await closeAnonymizedProxy(anonymizedProxyUrl, true).catch(() => {});
    }
  };
}

function buildLaunchOptions({ headless, proxyUrl, deviceMode = "desktop", proxyGeoip = true, humanize }) {
  const isMobile = deviceMode === "mobile";
  const shouldUseProxyGeoip = Boolean(proxyUrl && proxyGeoip && cloakBrowser.geoip);
  const platformArgs = process.platform === "linux" ? DEFAULT_CHROMIUM_ARGS : [];
  const args = isMobile
    ? [...platformArgs, `--window-size=${MOBILE_VIEWPORT.width},${MOBILE_VIEWPORT.height}`]
    : (headless ? platformArgs : [...platformArgs, "--start-maximized"]);

  const launchOptions = {
    headless,
    humanize: typeof humanize === "boolean" ? humanize : cloakBrowser.humanize,
    viewport: isMobile ? MOBILE_VIEWPORT : (headless ? DEFAULT_VIEWPORT : null)
  };

  // Explicit locale/timezone override CloakBrowser geoip. Keep the default TR identity only when
  // there is no proxy geoip to match; otherwise proxy IP and browser signals would conflict.
  if (cloakBrowser.locale || !shouldUseProxyGeoip) {
    launchOptions.locale = cloakBrowser.locale || ISTANBUL_LOCALE;
  }
  if (cloakBrowser.timezone || !shouldUseProxyGeoip) {
    launchOptions.timezone = cloakBrowser.timezone || ISTANBUL_TIMEZONE;
  }

  const contextOptions = {};
  if (!shouldUseProxyGeoip) {
    contextOptions.geolocation = randomIstanbulGeolocation();
    contextOptions.permissions = ["geolocation"];
  }

  if (isMobile) {
    if (MOBILE_USER_AGENT) {
      launchOptions.userAgent = MOBILE_USER_AGENT;
    }
    Object.assign(contextOptions, {
      isMobile: true,
      hasTouch: true,
      screen: MOBILE_VIEWPORT,
      deviceScaleFactor: 3
    });
  }

  launchOptions.contextOptions = contextOptions;

  if (proxyUrl) {
    launchOptions.proxy = proxyUrl;
    launchOptions.geoip = shouldUseProxyGeoip;
  }
  if (launchOptions.humanize && cloakBrowser.humanPreset && cloakBrowser.humanPreset !== "default") {
    launchOptions.humanPreset = cloakBrowser.humanPreset;
  }
  if (args.length) {
    launchOptions.args = args;
  }

  return launchOptions;
}

async function launchBrowserContext(options) {
  const { launchContext, launchPersistentContext } = await loadCloakBrowser();
  const proxy = await anonymizeProxyIfNeeded(options.proxyUrl);
  const launchOptions = buildLaunchOptions({
    ...options,
    proxyUrl: proxy.proxyUrl,
    proxyGeoip: proxy.proxyUrl === options.proxyUrl
  });
  let context;

  // Hesap-başına profil verildiyse (profileKey) DAİMA o izole kalıcı profili kullan — cihaz tutarlılığı
  // için en önemli sinyal. Yoksa eski davranış (config'e göre tek profil veya taze context).
  const perAccountDir = profileDirFor(options.profileKey);
  if (perAccountDir) {
    context = await launchPersistentContext({ ...launchOptions, userDataDir: perAccountDir });
  } else if (cloakBrowser.persistentProfile) {
    context = await launchPersistentContext({ ...launchOptions, userDataDir: cloakBrowser.userDataDir });
  } else {
    context = await launchContext(launchOptions);
  }

  const closeContext = context.close.bind(context);
  context.close = async (...args) => {
    try {
      return await closeContext(...args);
    } finally {
      await proxy.close();
    }
  };

  return context;
}

module.exports = {
  DEFAULT_VIEWPORT,
  MOBILE_VIEWPORT,
  MOBILE_USER_AGENT,
  ISTANBUL_TIMEZONE,
  ISTANBUL_LOCALE,
  ISTANBUL_GEO_BOUNDS,
  randomIstanbulGeolocation,
  anonymizeProxyIfNeeded,
  buildLaunchOptions,
  launchBrowserContext
};
