export const COPY = Object.freeze({
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
    "This is a code format QRWarden does not read (for example Micro QR or a multi-part code).",
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
  installIphone:
    "Open Share, choose Add to Home Screen, leave Open as Web App turned on when it is shown, then open QRWarden from its Home Screen icon while online. Wait for Ready offline before using it offline.",
  installMac:
    "Choose File > Add to Dock, open QRWarden from the Dock while online, and wait for Ready offline.",
  installTested:
    "Use your browser's Install QRWarden option, open the installed app while online, and wait for Ready offline.",
  installUnavailable:
    "Install guidance is not available for this browser. You can still use QRWarden in this tab and prepare it for offline use.",
});

export type CopyKey = keyof typeof COPY;
