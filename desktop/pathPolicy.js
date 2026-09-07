const path = require("path");
function validateUrl(value) { let parsed; try { parsed = new URL(String(value || "").trim()); } catch (error) { throw new Error("Enter a valid URL, for example https://example.com"); } if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error("Only http:// and https:// URLs are supported"); return parsed; }
function defaultOutputDir(documentsDir, host) { const stamp = new Date().toISOString().replace(/[:.]/g, "-"); return path.join(documentsDir, "Website Cloner", host.replace(/[^a-z0-9.-]/gi, "-"), stamp); }
module.exports = { defaultOutputDir, validateUrl };
