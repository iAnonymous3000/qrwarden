# GitHub repository setup

Create the repository as private, keep Issues and Discussions disabled, and complete every setting available at private visibility around the first signed upload. When the source is ready, change visibility to public, immediately enable and verify private vulnerability reporting from a non-admin account, and return the repository to private visibility if that route cannot be established. Repository settings are part of the security boundary and cannot be represented by source files alone. Do not link or announce the repository until the private reporting route works.

## Initial public setup

- Set the repository description to identify QRWarden as a local-first QR code inspector and a development candidate. Use topics such as `qr-code`, `privacy`, `security`, `pwa`, and `typescript`.
- Set the real GitHub owner and repository in `release/constants.json` once the public URL exists. Add matching `repository` and `bugs` metadata to `package.json`, then synchronize `package-lock.json`. Add `homepage` only after a canonical site is approved.
- Add `CODEOWNERS` only after the responsible, write-capable GitHub handles are known.
- Publish the real maintainer roster and a dedicated private conduct-reporting address before actively inviting community contributions. Do not route conduct reports through security advisories.
- Leave Issues and Discussions disabled until the maintainer roster, conduct route, and moderation responsibility are real. Then enable Issues with the committed forms and keep Discussions disabled unless someone is assigned to moderate them.
- Commit only reviewed values that are deliberately public and required by the release contract: the canonical domain, public Cloudflare account ID, GitHub identity, maintainer roster, Minisign public key, and its fingerprint. Keep Cloudflare zone, Access application, identity-provider, service-token, preview, version, deployment, and credential values in operational environment or evidence records outside public source. Never replace a public placeholder with a guess or example secret.
- Treat QRWarden as a working project name until the checks in `docs/NAME_CLEARANCE.md` are complete. Public source publication is not legal clearance or a claim of trademark rights.

## Repository settings

- Set `main` as the default branch.
- Allow GitHub-authored Actions only and require full-length commit SHA pins. The committed workflows currently meet both constraints.
- Keep the default Actions token permission restricted to read access and leave **Allow GitHub Actions to create and approve pull requests** disabled. Grant write permissions only to reviewed jobs that need a specific permission.
- Require approval for workflows from all external fork contributors if the resulting review load is acceptable. Never expose write tokens or repository secrets to fork pull requests.
- Verify that the public dependency graph is populated. Enable Dependabot alerts and Dependabot security updates; `.github/dependabot.yml` already configures version updates.
- Enable CodeQL default setup for JavaScript and TypeScript and review its initial findings before treating the repository as clean.
- Confirm that automatic public-repository secret scanning is active. Keep account-level push protection enabled and enable repository push protection when the repository settings and plan expose it.
- Enable private vulnerability reporting as soon as public visibility makes the setting available, subscribe active maintainers to security-alert notifications, and confirm that the route in `SECURITY.md` works from a non-admin account before linking or announcing the repository.
- Select a maintained DCO check or GitHub App, review its requested permissions, and require it so the sign-off rule in `CONTRIBUTING.md` is enforced.
- Set a concise description and appropriate topics. Leave the website field empty until the canonical domain is approved.

## Main branch ruleset

- Require pull requests and resolved review conversations for ordinary changes.
- Require signed commits, linear history, and protection against force pushes and branch deletion.
- Enable rebase merging when signed commits are required. GitHub cannot squash-merge another author's pull request through the web interface while preserving that author's verified signature.
- Require the `validate` and `browser` CI jobs plus the selected DCO check after each has completed successfully once.
- Limit ruleset bypass to the smallest reviewed maintainer group.
- Review passes, failures, and bypasses in Rules Insights. Require a documented follow-up review after any emergency bypass.

## Release environment

- Create the protected environment named `production-release`, matching `.github/workflows/release.yml`.
- Restrict deployment branches to protected `main`.
- Add independent human reviewers. Enable self-review prevention only after another eligible reviewer exists, so a one-maintainer project cannot deadlock the release environment.
- Store only deployment credentials in GitHub. Never store the Minisign secret key or its passphrase in the repository, Actions, or Cloudflare.
- Run the manual release workflow only for the exact signed protected-main commit and version.

Recheck these settings before every stable release and after any maintainer, credential, domain, or repository-ownership change.
