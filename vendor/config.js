const path = require("path");

function optionalBoolean(value) {
  if (typeof value === "undefined" || value === "") return undefined;
  return String(value).toLowerCase() === "true";
}

module.exports = {
  cloakBrowser: {
    locale: process.env.CLOAKBROWSER_LOCALE || undefined,
    timezone: process.env.CLOAKBROWSER_TIMEZONE || undefined,
    geoip: optionalBoolean(process.env.CLOAKBROWSER_GEOIP) ?? true,
    humanize: optionalBoolean(process.env.CLOAKBROWSER_HUMANIZE) ?? true,
    humanPreset: process.env.CLOAKBROWSER_HUMAN_PRESET || "default",
    persistentProfile: optionalBoolean(process.env.CLOAKBROWSER_PERSISTENT_PROFILE) ?? false,
    userDataDir: process.env.CLOAKBROWSER_USER_DATA_DIR || path.join(__dirname, "..", "storage", "browser-profile")
  }
};
