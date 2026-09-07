<p align="center">
  <img src="docs/hero.svg" alt="Website Cloner — capture the web, keep the files" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-4b5ce8?style=flat-square" alt="MIT license"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Version-0.1.0-4b5ce8?style=flat-square" alt="Version 0.1.0"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 20 or newer"></a>
  <a href="#under-the-hood"><img src="https://img.shields.io/badge/Built_with-Electron-47848f?style=flat-square&amp;logo=electron&amp;logoColor=white" alt="Built with Electron"></a>
  <a href="https://github.com/CloakHQ/cloakbrowser"><img src="https://img.shields.io/badge/Powered_by-CloakBrowser-192347?style=flat-square" alt="Powered by CloakBrowser"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#build">Build</a> ·
  <a href="https://github.com/kalimeraa/website-cloner/issues">Report an issue</a>
</p>

Website Cloner turns a website into a folder you can browse, inspect, and keep. Capture browser-rendered pages and their assets with CloakBrowser, preview the saved copy over local HTTP, and open the files in your own editor.

## ✨ What you can do

- **🌐 Capture rendered pages.** Save HTML plus captured CSS, scripts, images, and fonts through a Chromium browser context.
- **🎚️ Control the crawl.** Set the link depth and page limit, from a single page to a multi-page capture.
- **🔌 Configure a proxy.** Choose HTTP, HTTPS, SOCKS4, or SOCKS5 with separate host, port, username, and password fields.
- **📁 Keep editable files.** Choose an output folder and access the saved source directly.
- **🖥️ Preview over HTTP.** Open the saved entry page in your default browser using a local preview server.
- **🕘 Revisit captures.** Desktop history lists runs newest first, with timestamps, preview, open-folder, and delete actions.
- **📸 See the result.** Follow progress and view the screenshot associated with a completed capture.

<a id="screenshots"></a>
## 📸 The full desktop interface

A real `example.com` capture with Website Cloner — from capture settings to the finished result and download history.

![Full Website Cloner interface after capturing example.com](docs/app-full-interface.png)

<details>
<summary>View the example.com page screenshot saved by the app</summary>

![example.com page screenshot](docs/captured-site-example.png)

</details>

<a id="quick-start"></a>
## 🚀 Quick start

Install **Node.js 20 or newer** and npm, then run:

```bash
git clone https://github.com/kalimeraa/website-cloner.git
cd website-cloner
npm ci
npm start
```

`npm run dev` launches the same desktop app. The capture browser is separate from Electron; CloakBrowser downloads its Chromium runtime when needed, so allow time and an internet connection on the first capture.

For a quick first run, enter `https://example.com`, set **Depth** to `0` and **Max pages** to `1`, then select **Start cloning**.

Before capturing, Website Cloner displays **Checking connection…** and checks the target through your selected connection. If the target cannot be reached, it checks `example.com` and `microsoft.com` to distinguish a website problem from an unavailable connection. With a proxy selected, all checks go through that proxy; there is no direct fallback.

Connection errors appear in English, including **No internet connection**, **Unable to reach this website**, **Proxy authentication failed**, and **The proxy connection timed out**. Fix the connection or proxy settings and select **Start cloning** again. Proxy passwords are not included in these messages. Connectivity checks are best-effort: a firewall blocking all checks can also appear as an unavailable connection. Saved local previews do not require this check.

<a id="how-it-works"></a>
## 🧭 How it works

1. **Enter a URL.** Use an `http://` or `https://` address. Add a proxy if needed.
2. **Choose the scope.** Depth `0` captures the starting page; `1` follows its links; `2` also follows links from those pages. Max pages caps the crawl. Assets are captured independently of link depth.
3. **Capture.** CloakBrowser loads each page, lets it render, and collects available resources. Saved references are rewritten to local paths.
4. **Preview and use the files.** Select **Open preview** to browse the local copy or **Open folder** to inspect its source.

Each capture is a snapshot of browser-visible content. Server-side application code, databases, and live backend services are not part of a website download; features that depend on them may still need the original service. A successfully loaded page is not proof of bypassing an anti-bot challenge.

## 🔌 Proxy settings

Select a protocol, then fill in the host and port. Username and password are optional. The UI assembles a URL such as:

```text
http://username:password@proxy.example.com:8080
socks5://username:password@proxy.example.com:1080
```

Use **No proxy** for a direct connection. Credentials are encoded when the proxy URL is assembled. Avoid sharing your local job-history files: they can contain the proxy configuration used for a run.

## 📂 What gets saved

The default destination groups captures by domain and timestamp:

```text
Documents/Website Cloner/
└── example.com/
    └── <timestamp>/
        ├── example.com/
        │   └── index.html
        ├── <asset-host>/       # When external assets are captured
        ├── screenshot.png     # Best-effort page screenshot
        └── mirror-manifest.json
```

The manifest records the entry page and capture details. **Open folder** gives you ordinary files to edit, copy, or archive. Keep the app running while using its local HTTP previews.

## 🌍 HTTP mode

An experimental browser entry point is also included:

```bash
npm run serve
```

It listens at <http://127.0.0.1:4173>. The desktop app is the main interface for persistent history and native folder actions.

<a id="build"></a>
## 📦 Build a desktop package

```bash
npm run build
```

Electron Builder writes artifacts to `dist/`. Native build targets are configured for **macOS (DMG)**, **Windows (NSIS)**, and **Linux (AppImage/deb)**. Build on the matching operating system. Signing and notarization need your own certificates; a local package build does not create a signed release automatically.

<a id="under-the-hood"></a>
## 🛠️ Under the hood

**Electron** provides the desktop shell, **CloakBrowser + Playwright** drive browser capture, and Node.js handles local storage and HTTP previews.

```text
desktop/          Electron main process, bridge, UI, and local services
vendor/           Browser adapter and capture engine
build/            Application icon and packaging assets
docs/             Product artwork and real app screenshots
test/             Node.js tests
serve.js          Experimental HTTP entry point
```

Run the tests with `npm test`. For an end-to-end desktop check, run `node test/desktop.smoke.cjs` with a graphical desktop and internet access: it tests offline/proxy errors and then captures `example.com` using an isolated temporary profile and output folder. Contributions are welcome: open an issue with reproduction steps, or send a focused pull request describing the change and how you tested it.

## 💜 Open source

Website Cloner is released under the [MIT license](LICENSE). Use, modify, distribute, and sell the software while preserving its license notice. The software license does not relicense content captured from other websites.

Built with [Electron](https://github.com/electron/electron), [CloakBrowser](https://github.com/CloakHQ/cloakbrowser), [Playwright](https://github.com/microsoft/playwright), [proxy-chain](https://github.com/apify/proxy-chain), and [JSZip](https://github.com/Stuk/jszip).
