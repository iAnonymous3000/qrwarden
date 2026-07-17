# Browser support

## Minimum supported engines

The production bundle is compiled with a single Vite build target:
`safari16.4` (see `build.target` in `vite.config.ts`). iOS browsers all use
WebKit, and Safari 16.4 is the first WebKit release with the worker
`OffscreenCanvas` support the decoder requires, so that release sets the
floor for every platform.

In practice that means:

- **WebKit / Safari:** 16.4 or later (covers all iOS and iPadOS browsers,
  which share the system WebKit).
- **Chromium (Chrome, Edge, Brave) and Firefox:** any release that supports
  the same JavaScript syntax and worker features as Safari 16.4. All
  Chromium and Firefox versions in the release test matrix (below) are far
  newer than this floor. On Windows, Firefox install guidance additionally
  assumes Firefox 143+ (Mozilla distribution) or 150+ (Microsoft Store
  distribution), per `release/browser-matrix.json`.

The decoder also requires WebAssembly (the worker route is served with
`script-src 'self' 'wasm-unsafe-eval'`); every engine at or above the floor
supports it.

## JavaScript is required

QRWarden inspects QR codes entirely on the device. Decoding runs in a Web
Worker (WebAssembly), and all analysis of the decoded content runs as
JavaScript in the browser. There is no server-side fallback because there is
no server-side processing: the app makes no network requests during
analysis, and no data leaves the browser. Without JavaScript there is
nothing the page can do.

## What happens on unsupported browsers

- **JavaScript disabled:** the page shows a static `<noscript>` notice in
  `index.html` explaining that QRWarden needs JavaScript and why. The notice
  is plain semantic HTML, so it stays readable even if the stylesheet does
  not load.
- **JavaScript enabled, but the engine is older than the build target:** the
  module script may fail to parse or execute, and the page can remain blank.
  The `<noscript>` notice cannot help here because scripting is enabled.
  Update the browser to a version at or above the floor listed above.

## Release test matrix

Support claims above are the compile floor. What each release is actually
verified on is the six-platform matrix in `release/browser-matrix.json`:
Windows 11, macOS (current and previous), Android (current and previous),
iOS (current and previous), iPadOS (current and previous), and Ubuntu LTS,
including tab and installed modes where listed. Exact build numbers are
recorded for every release.
