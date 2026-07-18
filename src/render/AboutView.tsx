import type { RefObject } from "preact";

import { ANALYZER_DATA_STATUS, ANALYZER_VERSION } from "../analyzer";
import { COPY } from "../copy";
import { APP_LOCALE } from "../copy/locale";
import { detectInstallGuidance } from "./installGuidance";
import type { Theme } from "./theme";

const DEVELOPMENT_COMMIT = "0000000000000000000000000000000000000000";

interface AboutReleaseDetails {
  readonly releaseId: string;
  readonly signingPublicKey: string;
  readonly signingFingerprint: string;
  readonly dnsKeyOwner: string;
  readonly sourceRepository: string | null;
}

interface AboutViewProps {
  readonly headingRef: RefObject<HTMLHeadingElement>;
  readonly theme: Theme;
  readonly followsSystemTheme: boolean;
  readonly release: AboutReleaseDetails;
  readonly backLabel: string;
  readonly onOpenGlossary: () => void;
  readonly onUseSystemTheme: () => void;
  readonly onBack: () => void;
}

function releaseValue(value: string): string {
  return /^<SET_[A-Z0-9_]+>$/u.test(value) ? COPY.notConfiguredValue : value;
}

function sourceRepositorySegments(value: string): readonly string[] {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => `/${segment}`);
    return [
      `${parsed.protocol}//${parsed.host}`,
      ...path,
      `${parsed.search}${parsed.hash}`,
    ].filter((segment) => segment.length > 0);
  } catch {
    return [value];
  }
}

function displayedReleaseId(value: string): string {
  return value.endsWith(`+${DEVELOPMENT_COMMIT}`)
    ? `${value.slice(0, -(DEVELOPMENT_COMMIT.length))}development`
    : value;
}

export function AboutView({
  headingRef,
  theme,
  followsSystemTheme,
  release,
  backLabel,
  onOpenGlossary,
  onUseSystemTheme,
  onBack,
}: AboutViewProps) {
  // The installed-app window shares the browser tab's user agent, so
  // installed state comes from the display mode instead of sniffing.
  const alreadyInstalled =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const guidance = detectInstallGuidance(navigator.userAgent, alreadyInstalled);

  return (
    <article class="prose-card">
      <p class="eyebrow">{COPY.aboutEyebrow}</p>
      <h1 ref={headingRef} tabIndex={-1}>{COPY.aboutTitle}</h1>
      <p class="lead">{COPY.aboutLead}</p>
      <p>
        <button type="button" class="text-button" onClick={onOpenGlossary}>
          {COPY.glossaryLink}
        </button>
      </p>
      {APP_LOCALE === "en" ? null : (
        <p class="microcopy">{COPY.aboutEnglishEvidenceNote}</p>
      )}
      <section class="install-card">
        <h2>{guidance.heading}</h2>
        <p>{guidance.body}</p>
      </section>
      <section class="appearance-card" aria-labelledby="appearance-title">
        <h2 id="appearance-title">{COPY.appearanceHeading}</h2>
        <p>
          {followsSystemTheme
            ? COPY.appearanceFollowing(theme)
            : COPY.appearanceUsing(theme)}
        </p>
        <button
          type="button"
          class="secondary-button"
          disabled={followsSystemTheme}
          onClick={onUseSystemTheme}
        >
          {followsSystemTheme ? COPY.usingDeviceSetting : COPY.useDeviceSetting}
        </button>
      </section>
      <details class="technical-details">
        <summary>{COPY.technicalDetails}</summary>
        <dl class="about-grid">
          <div><dt>{COPY.aboutReleaseLabel}</dt><dd>{displayedReleaseId(release.releaseId)}</dd></div>
          <div><dt>{COPY.analyzerLabel}</dt><dd>{ANALYZER_VERSION}</dd></div>
          <div><dt>{COPY.aboutPslSnapshotLabel}</dt><dd>{ANALYZER_DATA_STATUS.publicSuffix.captured}</dd></div>
          <div><dt>{COPY.aboutIanaSnapshotLabel}</dt><dd>{ANALYZER_DATA_STATUS.ianaSpecialPurpose.captured}</dd></div>
          <div><dt>{COPY.aboutUnicodeLabel}</dt><dd>{ANALYZER_DATA_STATUS.unicodeSecurity.unicodeVersion}</dd></div>
          <div><dt>{COPY.aboutCodeLicenseLabel}</dt><dd>AGPL-3.0-or-later</dd></div>
          <div><dt>{COPY.aboutDataLicensesLabel}</dt><dd>MPL-2.0 · CC0-1.0 · Unicode-3.0</dd></div>
          <div><dt>{COPY.aboutFingerprintLabel}</dt><dd><bdi>{releaseValue(release.signingFingerprint)}</bdi></dd></div>
          <div><dt>{COPY.aboutPublicKeyLabel}</dt><dd><bdi>{releaseValue(release.signingPublicKey)}</bdi></dd></div>
          <div><dt>{COPY.aboutDnsAnchorLabel}</dt><dd><bdi>{releaseValue(release.dnsKeyOwner)}</bdi></dd></div>
          <div>
            <dt>{COPY.aboutSourceLabel}</dt>
            <dd class="source-repository">
              {release.sourceRepository === null ? (
                COPY.notConfiguredValue
              ) : (
                <bdi>
                  {sourceRepositorySegments(release.sourceRepository).map((segment) => (
                    <span class="repository-segment" key={segment}>
                      {segment}<wbr />
                    </span>
                  ))}
                </bdi>
              )}
            </dd>
          </div>
        </dl>
      </details>
      <button type="button" class="primary-button" onClick={onBack}>{backLabel}</button>
    </article>
  );
}
