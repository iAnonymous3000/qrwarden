import type { AnalysisSignalCode, PayloadKind } from "../../analyzer/types";

export interface SignalGlossaryCopy {
  readonly title: string;
  readonly explanation: string;
}

export const EN_COPY = Object.freeze({
  brand: "QRWarden",
  tagline: "Scan. Inspect. Decide.",
  primaryMessage: "See what a QR code contains before you act.",
  privacyStatement:
    "Scans stay in this browser. QRWarden does not upload images or QR contents.",
  noReviewHeading: "No review signals found.",
  noReviewBody:
    "QRWarden did not find the offline URL patterns that require extra confirmation. It did not visit or verify this website.",
  reviewHeading: "Review before opening.",
  reviewBody: (count: number): string =>
    `QRWarden found ${count} ${count === 1 ? "detail" : "details"} to review. These signals do not prove the website is harmful.`,
  inspectOnlyHeading: "Decoded for inspection.",
  inspectOnlyBody:
    "Review the decoded contents below. QRWarden does not act on this code type.",
  rawBytesHeading: "Encoding could not be confirmed.",
  rawBytesBody:
    "QRWarden could not confirm how this text is encoded, so it is shown as bytes. QRWarden does not guess encodings.",
  emptyHeading: "Empty QR code.",
  emptyBody: "This QR code does not contain any data.",
  launchNotice:
    "Your browser or operating system may open this link in a browser or an installed app.",
  offlineLimitations:
    "Not checked offline: current site content, redirects, reputation, ownership, or certificate status.",
  openLink: "Open link",
  continueToLink: "Continue to link…",
  confirmHeading: "Open this link?",
  confirmBody: (destination: string): string =>
    `You are about to open ${destination}. Review the details above before continuing.`,
  confirmFullUrlLabel: "Complete address",
  cancel: "Cancel",
  scanAnother: "Scan another code",
  chooseImage: "Choose an image",
  retryCamera: "Try camera again",
  resumeScanning: "Resume scanning",
  tryAnotherCode: "Try another code",
  revealWarning: "Sensitive content may be visible to people nearby.",
  clipboardWarning:
    "Your operating system or cloud clipboard may share copied content with other devices or apps.",
  copied: "Copied.",
  copyFailed: "Could not copy this value.",
  noQrHeading: "No QR code found.",
  noQrBody:
    "QRWarden could not find a QR code in this image. Try a sharper image, crop closer to the code, and reduce glare.",
  unsupportedCodeHeading: "Unsupported code type.",
  unsupportedCodeBody:
    "This is a code format QRWarden does not read (for example a multi-part or non-canonical code).",
  tooManyHeading: "Too many QR codes.",
  tooManyBody:
    "QRWarden found at least nine QR codes. Crop the image, move closer, or scan fewer codes at once.",
  chooseQrHeading: "Choose a QR code.",
  chooseQrBody:
    "QRWarden found several QR codes. Select one to inspect.",
  timeoutHeading: "Took too long.",
  timeoutBody: "Reading this image timed out. Try a smaller or clearer image.",
  imageTooLargeHeading: "Image too large.",
  imageTooLargeBody:
    "This image is larger than QRWarden accepts. Use an image no larger than 25 MB or 25 megapixels, and no more than 8,192 pixels on a side.",
  unsupportedImageHeading: "Unsupported image type.",
  unsupportedImageBody:
    "Use a screenshot or export this image as JPEG, PNG, or WebP.",
  imageUnreadableHeading: "Image unreadable.",
  imageUnreadableBody:
    "QRWarden could not read this image. Try another JPEG, PNG, or WebP file.",
  chooseOneImageHeading: "Choose one image.",
  chooseOneImageBody: "Drop one JPEG, PNG, or WebP image at a time.",
  imageStoppedHeading: "Image reading stopped.",
  imageStoppedBody:
    "Reading stopped when QRWarden went into the background. Choose the image again to continue.",
  readerStoppedHeading: "Reader stopped.",
  readerStoppedBody:
    "The code reader stopped unexpectedly. Return to the scanner and try again.",
  linkChangedHeading: "Link opening stopped.",
  linkChangedBody:
    "QRWarden could not confirm that this action still matches the result you reviewed. Scan the code again.",
  preparingOfflineHeading: "Preparing offline use.",
  preparingOfflineBody: "Setting up offline use…",
  checkingVersionHeading: "Checking app version.",
  checkingVersionBody:
    "Scanning and review controls are temporarily unavailable while this check finishes.",
  readyOfflineHeading: "Ready offline.",
  readyOfflineBody:
    "QRWarden is ready to scan without an internet connection.",
  offlineIncompleteHeading: "Offline setup incomplete.",
  offlineIncompleteBody:
    "Offline setup did not finish. QRWarden works while online and will retry setup on the next online launch.",
  updateReadyHeading: "Update ready.",
  updateReadyBody:
    "A QRWarden update is ready. Choose Install update when scanning and review are idle.",
  updateFailedHeading: "Update or verification failed.",
  updateFailedBody:
    "QRWarden could not finish an update or verify the app files. Reload while online if scanning remains unavailable.",
  reloadApp: "Reload app",
  installUpdate: "Install update",
  updateBusyBody: "Finish or leave this screen, then choose Install update.",
  updateStartingBody: "Starting the update…",
  updateUnavailableBody:
    "This update is no longer available. QRWarden will check again when scanning and review are idle.",
  cameraUnavailableHeading: "Camera unavailable.",
  cameraUnavailableBody:
    "Camera scanning is not available here. Choose an image instead.",
  cameraAccessHeading: "Camera access needed.",
  cameraAccessBody:
    "Allow camera access for this site and browser. On iPhone or iPad, open Settings → Privacy & Security → Camera and turn on your browser. You can also choose an image instead.",
  braveIosCameraBody:
    "Brave detected: iOS grants the camera to the Brave app as a whole. Open Settings → Apps → Brave, allow Camera, then try again.",
  noCameraHeading: "No camera found.",
  noCameraBody:
    "No camera is available on this device. Choose an image instead.",
  cameraStartHeading: "Camera could not start.",
  cameraStartBody:
    "The camera did not respond or could not start. Check camera permission, close other camera apps, try again, or choose an image instead.",
  cameraStoppedHeading: "Camera stopped.",
  cameraStoppedBody:
    "The camera stopped. Tap Resume scanning to start it again.",
  cameraPausedHeading: "Camera paused.",
  cameraPausedBody:
    "Scanning stopped while QRWarden was in the background. Tap Resume scanning to continue.",
  lookingForCode: "Looking for a code…",
  startingCamera: "Starting camera…",
  torchUnavailableHeading: "Torch unavailable.",
  torchUnavailableBody:
    "The torch setting could not be changed. Scanning is still active.",
  zoomUnavailableHeading: "Zoom unavailable.",
  zoomUnavailableBody:
    "The zoom setting could not be changed. Scanning is still active.",
  switchUnavailableHeading: "Camera switch unavailable.",
  switchUnavailableBody:
    "QRWarden could not switch cameras. Scanning continues with the previous camera.",
  credentialsExplanation: (host: string): string =>
    `Text before @ is not the destination. The actual host is ${host}.`,
  installIphoneHeading: "iPhone or iPad",
  installIphone:
    "Open Share, choose Add to Home Screen, leave Open as Web App turned on when it is shown, then open QRWarden from its Home Screen icon while online. Wait for Ready offline before using it offline.",
  installMacHeading: "Safari on Mac",
  installMac:
    "Choose File > Add to Dock, open QRWarden from the Dock while online, and wait for Ready offline.",
  installTestedHeading: "Install QRWarden",
  installTested:
    "Use your browser's Install QRWarden option, open the installed app while online, and wait for Ready offline.",
  installUnavailableHeading: "Guidance unavailable",
  installUnavailable:
    "Install guidance is not available for this browser. You can still use QRWarden in this tab and prepare it for offline use.",
  pasteHint: "You can also paste or drop an image anywhere on this page.",
  signalNeedsReview: "Needs review",
  signalContext: "Context",
  copyReportButton: "Copy report",
  reportTitle: "QRWarden inspection report",
  reportHiddenValue: "(hidden)",
  reportKindLabel: "Kind",
  reportStatusLabel: "Status",
  reportSignalsLabel: "Signals",
  reportTruncatedNote: "(value truncated for display)",
  // The analyzer states its permanent limitations as these exact English
  // sentences; the copied report maps them onto the localized forms below.
  limitationContentOnly:
    "Analysis uses only the content contained in the QR code.",
  limitationNoVisit:
    "QRWarden does not visit the destination or check reputation, DNS, TLS, redirects, domain age, or page content.",
  skipToContent: "Skip to content",
  brandHomeLabel: "QRWarden home",
  navInfoLabel: "Information",
  navPrivacy: "Privacy",
  navAbout: "About",
  themeToggleLabel: "Dark",
  themeToggleName: "Dark mode",
  themeToLight: "Switch to light mode",
  themeToDark: "Switch to dark mode",
  heroEyebrow: "Private by design · analyzed on device",
  heroCopy:
    "Scan with your camera or choose an image. QRWarden decodes and explains the contents on this device without visiting the destination.",
  sourceCameraTitle: "Scan with camera",
  sourceCameraBody: "Point your camera at a QR code",
  sourceImageTitle: "Choose an image",
  sourceImageBody: "JPEG, PNG, or WebP · up to 25 MB",
  privacyPromiseTitle: "Your scan stays here.",
  stepsLabel: "How QRWarden works",
  stepScan: "Scan",
  stepScanDetail: "Camera or image",
  stepInspect: "Inspect",
  stepInspectDetail: "See the real contents",
  stepDecide: "Decide",
  stepDecideDetail: "You choose what happens",
  readingHeading: "Reading image…",
  readingBody: "The image is being decoded on this device.",
  cameraEyebrow: "Camera scan",
  cameraHeading: "Hold the QR code inside the frame",
  videoPreviewLabel: "Live camera preview",
  cameraSelectLabel: "Camera",
  cameraSelectedAutomatically: "Camera selected automatically",
  zoomLabel: "Zoom",
  torchOn: "Turn torch on",
  torchOff: "Turn torch off",
  selectionEyebrow: "Multiple codes",
  selectionUnavailable: "Unavailable",
  unsupportedCodeChip: "Unsupported code",
  positionUnavailable: "position unavailable",
  selectionOptionLabel: (index: number, position: string, kind: string): string =>
    `Code ${index}, ${position}, ${kind}`,
  actualDestination: "Actual destination",
  signalsHeading: "Details to notice",
  signalExplainerSummary: "What this means",
  contentsHeading: "Decoded contents",
  limitsHeading: "What offline analysis cannot check",
  sensitiveChip: "Sensitive",
  reveal: "Reveal",
  mask: "Mask",
  copyField: (label: string): string => `Copy ${label}`,
  showField: (label: string): string => `Show ${label}`,
  hideField: (label: string): string => `Hide ${label}`,
  omittedFromDisplay: (omitted: number, total?: number): string =>
    total === undefined
      ? `${omitted} omitted from display.`
      : `${omitted} omitted from display (${total} total).`,
  truncatedNote: "Value truncated for display.",
  lockedFieldDetails: "Details unavailable while the app version is checked.",
  backToScanner: "Back to scanner",
  backToAbout: "Back to About",
  privacyEyebrow: "Privacy",
  privacyTitle: "What stays on your device",
  privacyNoLookupHeading: "No destination lookup",
  privacyNoLookupBody:
    "QRWarden does not visit decoded links, request favicons, check reputation, or send scan contents to a server. Analysis uses only the bytes inside the QR code and pinned data shipped with the app.",
  privacyNoHistoryHeading: "No scan history",
  privacyNoHistoryBody:
    "Images, decoded content, and reports are kept only in memory while you review them. They are not stored in browser databases, caches, or URLs. Offline caches contain application files only, and a short-lived session marker may hold a release identifier while a verified update activates; neither contains scan contents. QRWarden may also store your light or dark appearance choice.",
  privacyHostingHeading: "App hosting traffic",
  privacyHostingBody:
    "Opening or updating QRWarden sends ordinary HTTPS requests for application files to the host. The host, hosting provider, and network can observe connection metadata such as your IP address, request time, user agent, and requested application files. QRWarden does not add scan contents to those requests.",
  privacyActionsHeading: "Actions you control",
  privacyActionsBody:
    "Opening a link sends it to your browser or operating system. Copying places the reviewed value on your system clipboard, which may sync with other devices or apps.",
  aboutEyebrow: "About",
  aboutTitle: "Built to show evidence, not a verdict.",
  aboutLead:
    "QRWarden explains observable properties of a QR code. It never calls a destination safe, trusted, malicious, or verified.",
  glossaryLink: "What each review signal means",
  appearanceHeading: "Appearance",
  appearanceFollowing: (theme: string): string =>
    `Following this device's ${theme} appearance.`,
  appearanceUsing: (theme: string): string => `Using ${theme} mode on this device.`,
  useDeviceSetting: "Use device setting",
  usingDeviceSetting: "Using device setting",
  technicalDetails: "Technical and release details",
  aboutReleaseLabel: "Application release",
  analyzerLabel: "Analyzer",
  aboutPslSnapshotLabel: "PSL snapshot",
  aboutIanaSnapshotLabel: "IANA snapshot",
  aboutUnicodeLabel: "Unicode",
  aboutCodeLicenseLabel: "First-party code license",
  aboutDataLicensesLabel: "Bundled data licenses",
  aboutFingerprintLabel: "Release key fingerprint",
  aboutPublicKeyLabel: "Release public key",
  aboutDnsAnchorLabel: "DNS trust anchor",
  aboutSourceLabel: "Source",
  notConfiguredValue: "Not configured in this development build",
  aboutEnglishEvidenceNote: "Technical signal details are shown in English.",
  glossaryEyebrow: "Signal glossary",
  glossaryTitle: "What each signal means",
  glossaryLead:
    "Signals describe observable properties of a decoded code. They are evidence to weigh, not a verdict about the destination.",
  footerFacts: "Local analysis only. No app analytics or telemetry. No verdicts.",
  footerLicense: "QRWarden · AGPL-3.0-or-later",
  titleCamera: "Camera scan",
  titleReading: "Reading image",
  titleSelection: "Choose a QR code",
  titleResult: "Inspection result",
  titleError: "Scanning problem",
  titlePrivacy: "Privacy",
  titleAbout: "About",
  titleGlossary: "Signal glossary",
  // Exact analyzer evidence strings mapped to localized display strings.
  // English is the identity mapping; the keys mirror every label the
  // analyzer's fields.add call sites emit today. Unlisted labels fall back
  // to the emitted English text marked lang="en".
  fieldLabels: Object.freeze({
    "Action": "Action",
    "Address": "Address",
    "Byte count": "Byte count",
    "Calendar": "Calendar",
    "Complete bootstrap payload": "Complete bootstrap payload",
    "Complete setup payload": "Complete setup payload",
    "Contact": "Contact",
    "Coordinates": "Coordinates",
    "Decoded content": "Decoded content",
    "Description": "Description",
    "Destination category": "Destination category",
    "Destination host": "Destination host",
    "Email": "Email",
    "Email BCC": "Email BCC",
    "Email CC": "Email CC",
    "Email body": "Email body",
    "Email recipient": "Email recipient",
    "Email subject": "Email subject",
    "Ends": "Ends",
    "Event": "Event",
    "Fragment": "Fragment",
    "Fragment names": "Fragment names",
    "Hexadecimal preview": "Hexadecimal preview",
    "Hidden network": "Hidden network",
    "Location": "Location",
    "Message body": "Message body",
    "Message recipient": "Message recipient",
    "Name": "Name",
    "Name components": "Name components",
    "Network name (SSID)": "Network name (SSID)",
    "Note": "Note",
    "OTP setup type": "OTP setup type",
    "Organization": "Organization",
    "Original QR content": "Original QR content",
    "Password": "Password",
    "Path": "Path",
    "Payment": "Payment",
    "Port": "Port",
    "Provisioning type": "Provisioning type",
    "QR content": "QR content",
    "Query names": "Query names",
    "Registrable domain": "Registrable domain",
    "Security type": "Security type",
    "Starts": "Starts",
    "Structured format": "Structured format",
    "Telephone": "Telephone",
    "Telephone number": "Telephone number",
    "Text": "Text",
    "Title": "Title",
    "URI scheme": "URI scheme",
    "Unicode host": "Unicode host",
  }),
  // Exact analyzer signal titles mapped to localized titles, ordered like
  // the signal glossary. Signal details stay parametric English sentences
  // until the analyzer emits message identifiers.
  signalTitles: Object.freeze({
    "Internationalized domain name": "Internationalized domain name",
    "Trailing-dot host": "Trailing-dot host",
    "Unencrypted HTTP": "Unencrypted HTTP",
    "IP-address destination": "IP-address destination",
    "Local or special-purpose destination": "Local or special-purpose destination",
    "Non-default port": "Non-default port",
    "Link-shortener destination": "Link-shortener destination",
    "Mixed writing systems": "Mixed writing systems",
    "ASCII-like internationalized label": "ASCII-like internationalized label",
    "Hidden or control character": "Hidden or control character",
    "Material browser rewrite": "Material browser rewrite",
    "Text before @ is not the destination": "Text before @ is not the destination",
    "Forbidden character in the address authority":
      "Forbidden character in the address authority",
    "Web address cannot be opened": "Web address cannot be opened",
  }),
  kindLabels: Object.freeze<Record<PayloadKind, string>>({
    "web-url": "Web link",
    wifi: "Wi-Fi details",
    otp: "One-time password setup",
    dpp: "Device provisioning",
    contact: "Contact",
    calendar: "Calendar entry",
    email: "Email details",
    sms: "Message details",
    telephone: "Telephone number",
    geo: "Location",
    payment: "Payment details",
    "custom-uri": "App link",
    gs1: "GS1 data",
    "iso-15434": "ISO/IEC 15434 data",
    empty: "Empty QR code",
    text: "Text",
    binary: "Raw bytes",
  }),
  signalGlossary: Object.freeze<Record<AnalysisSignalCode, SignalGlossaryCopy>>({
    "idn-hostname": {
      title: "Internationalized domain name",
      explanation:
        "The destination uses characters beyond plain ASCII. That is normal for many languages, so QRWarden shows both the Unicode and ASCII forms; check that the name you recognize matches both.",
    },
    "trailing-dot-host": {
      title: "Trailing-dot host",
      explanation:
        "The host ends with a dot, the explicit DNS root form. Browsers accept it, but links rarely use it and some sites treat the dotted name as a different origin.",
    },
    http: {
      title: "Unencrypted HTTP",
      explanation:
        "The address uses http://, so the connection is not encrypted. Anyone on the network path can read or change the page you would receive.",
    },
    "ip-address": {
      title: "IP-address destination",
      explanation:
        "The destination is a numeric network address instead of a domain name. Public services almost always share names, so a raw address deserves a closer look at where it actually points.",
    },
    "local-or-special-destination": {
      title: "Local or special-purpose destination",
      explanation:
        "The address points into a private, local, or otherwise special network range — somewhere inside your own network or device rather than the public internet.",
    },
    "non-default-port": {
      title: "Non-default port",
      explanation:
        "The address names an explicit port instead of the standard web port. That can be legitimate, but it is unusual in links meant for the public.",
    },
    "link-shortener": {
      title: "Link-shortener destination",
      explanation:
        "The host is a link-shortening service, so the real destination is decided by whoever created the short link and stays hidden until it is opened. QRWarden does not follow redirects, so it cannot show you where this leads.",
    },
    "mixed-scripts": {
      title: "Mixed writing systems",
      explanation:
        "The host mixes characters from different writing systems in a combination that Unicode's Highly Restrictive profile rejects. Mixing scripts is a common way to build lookalike names.",
    },
    "confusable-label": {
      title: "ASCII-like internationalized label",
      explanation:
        "Part of the host is written with non-ASCII characters that look like an ordinary ASCII name. A name that reads like a brand you know may be a different domain entirely.",
    },
    "hidden-character": {
      title: "Hidden or control character",
      explanation:
        "The code contains invisible or control characters outside the address authority. Hidden characters can make text read differently than it behaves.",
    },
    "material-browser-rewrite": {
      title: "Material browser rewrite",
      explanation:
        "A browser would materially rewrite this address while parsing it, so what you read in the code is not exactly what would open. QRWarden shows the parsed destination it verified.",
    },
    userinfo: {
      title: "Text before @ is not the destination",
      explanation:
        "Everything before the @ sign in a web address is ignored by the browser when choosing the site. Attackers place a familiar name there so the address reads like a site you trust.",
    },
    "forbidden-authority-character": {
      title: "Forbidden character in the address authority",
      explanation:
        "The part of the address that decides the destination contains characters that are never valid there. QRWarden disables opening because the destination cannot be shown faithfully.",
    },
    "malformed-web-url": {
      title: "Web address cannot be opened",
      explanation:
        "The text looks like a web address but does not parse as a complete, absolute HTTP or HTTPS address with a host, so there is no verified destination to open.",
    },
  }),
});

/**
 * Widens the inferred literal string types of the English dictionary so any
 * locale with the same keys, function arities, and nested shapes conforms.
 */
type WidenCopy<T> = T extends string
  ? string
  : T extends (...args: infer Args) => string
    ? (...args: Args) => string
    : { readonly [K in keyof T]: WidenCopy<T[K]> };

export type CopyDictionary = WidenCopy<typeof EN_COPY>;
