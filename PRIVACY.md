# Privacy

> Scans stay in this browser. QRWarden does not upload images or QR contents.

This document describes the development source and intended canonical deployment. It is not notice that a canonical service is live. Before launch, the project must publish an effective date, the responsible operator or controller, the selected hosting provider, its handling and retention of ordinary request metadata, an applicable privacy-rights process, and a real contact route. Those facts remain unset rather than being replaced with guesses.

QRWarden decodes QR codes, classifies payloads, parses eligible URLs, and creates reports on the device. It has no account, analytics, telemetry, advertising, crash reporter, URL collection, reputation service, or application backend. It does not fetch a decoded destination, favicon, preview, DNS answer, redirect, certificate, or blocklist result during inspection.

Decoded images, frames, bytes, text, filenames, reports, and destinations are held only in bounded in-memory work. QRWarden does not intentionally put them in application storage, service-worker caches, history, logs, error reports, or URLs. Sensitive values are masked after lifecycle changes. JavaScript cannot guarantee cryptographic erasure from browser memory.

Images can arrive by camera, file selection, drag and drop, clipboard paste, or — on an installed instance — the operating system's share sheet. A shared image is handed from the service worker to the open page as an in-memory message, is never written to caches or storage, and is discarded if no page appears to receive it. Every intake path enters the same bounded in-memory pipeline.

The interface language follows the browser's language setting (English and Spanish are available). The choice is derived on each launch and is not stored. Analyzer field labels, signal titles, and synthesized descriptors are localized when translations exist; parametric technical signal details and some registry category names remain English.

QRWarden may store one device-local appearance preference, `light` or `dark`, in browser storage after the user changes the theme. That preference contains no scan contents or report data, and clearing site data removes it.

Separately, the service worker caches application files for verified offline use, and a short-lived release identifier may be held in session storage while an update activates. Neither storage path contains decoded images, payloads, reports, or destinations.

## Network traffic

Opening or updating QRWarden requires ordinary HTTPS requests to the application host. The browser, network operator, host, and hosting provider may therefore observe normal connection metadata such as IP address, time, user agent, requested application assets, and transport/security information. Static hosting does not prevent that ordinary request metadata from reaching the host. It is distinct from decoded QR content, and application code does not add scan content to asset requests. The intended canonical deployment uses static assets only and does not give application code a server-side write path.

After an installed instance reports **Ready offline**, core image and camera scanning is designed to work without a network connection. The service worker may check the QRWarden origin for an application update only during the separate idle update lifecycle; it never includes scanned content.

## Explicit actions

Copy sends the reviewed displayed value to the operating-system clipboard. The OS or a configured cloud clipboard may synchronize it outside QRWarden's control.

Open is available only for eligible HTTP(S) reports and requires a direct, reviewed user action. Opening leaves the local inspection boundary and lets the destination, browser, network, extensions, and intermediaries process the request. QRWarden sends no `Referer`, but it cannot make the destination private or safe.

## Boundaries

This policy makes no promise about malicious or privileged browser extensions, a compromised browser/operating system/device, screenshots or screen recording, camera firmware, accessibility services, clipboard managers, backups, network infrastructure, or destinations a user explicitly opens. Self-hosted or modified builds have their own operator and privacy posture; their operators must publish truthful hosting-metadata and contact information rather than adopting unset canonical-deployment claims.
