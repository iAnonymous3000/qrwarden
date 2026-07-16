# Security policy

## Private reporting

Use GitHub's private vulnerability reporting form: open the repository's **Security** tab, choose **Advisories**, then **Report a vulnerability**. Do not file a public issue or pull request. Repository administrators must enable private vulnerability reporting as soon as public visibility makes it available, subscribe active maintainers to security-alert notifications, and verify the form from a non-admin account before linking or promoting the repository.

If the private form is unexpectedly unavailable, do not put vulnerability details in an issue, discussion, pull request, commit, or other public channel. A content-free public issue may ask administrators to restore the private route only when Issues are enabled. If Issues are disabled and the repository owner publishes no separate contact route, retain the report privately until the form is restored; the project does not claim an unconfigured fallback.

Reports should contain affected revision/version, impact, minimal reproduction steps using synthetic data, and any suggested mitigation. Do not send secrets, signing material, personal data, production QR payloads, or unnecessary captured images.

## Response expectations

Maintainers aim to acknowledge a report within three business days, provide an initial triage within seven business days, and send progress updates at least every fourteen days while remediation is active. These are targets, not a bug-bounty or payment promise.

## Supported versions

Before the first signed public release, no version is supported for production use. After launch, only the latest stable release receives security fixes unless an advisory says otherwise. A compromised signing-key event follows the recovery process in `SIGNING.md` and `RELEASE.md`.

## Disclosure

Please allow maintainers a reasonable private remediation window. After a fix is published and users have had time to update, maintainers publish a permanent GitHub security advisory describing affected versions, impact, mitigations, fixed release, and credit when desired. Existing releases and signatures are never replaced or silently modified.
