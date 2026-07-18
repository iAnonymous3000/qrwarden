# Cloudflare release operations

This runbook deploys QRWarden as Cloudflare Workers Static Assets. It does not use Pages, a server Worker, Workers Builds, Git integration, or an application binding. Cloudflare configuration is an operational release boundary: complete every readback and verification step rather than treating a successful upload as a release.

## Hard stops

Do not create the canonical deployment until all of these values are real and reviewed:

- the cleared canonical domain;
- the public Cloudflare account ID in `release/constants.json`;
- two public maintainer identities;
- the offline-generated Minisign public key and its fingerprint;
- the matching well-known public key and DNSSEC TXT value;
- the responsible operator, privacy effective date, request-metadata handling and retention, privacy-rights process, and contact route.

Never deploy the repository's ordinary `dist/` directory. A development build may contain the all-zero commit marker and placeholder release identity. Upload only the freshly extracted, remanifested bytes from the signed release archive.

The initial public deployment must be described as a signed beta or release rehearsal. With no independently verified OLD deployment, it cannot satisfy the stable-v1 rollback gate. After that signed beta has been verified and retained, a later release can use it as OLD and exercise the complete OLD 100% / NEW 0% state machine.

## One-time account and zone preparation

1. Add the canonical zone to Cloudflare and complete nameserver activation.
2. Enable DNSSEC and verify the parent DS record before relying on the release-key TXT record.
3. Enable Always Use HTTPS, require a minimum of TLS 1.2, and preserve the signed `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` response header. The `includeSubDomains; preload` directives commit the entire registrable canonical domain, including every subdomain, to HTTPS; confirm that commitment is acceptable for the zone before the first deployment, because preload-list inclusion is slow to reverse.
4. Disable every feature listed in `release/cloudflare-baseline.json`, including Workers Builds and Git integration, Workers Logs and observability, Network Error Logging, Web Analytics, Zaraz, Rocket Loader, email obfuscation, and content or script injection.
5. Create no KV, R2, D1, Durable Object, Queue, service binding, runtime secret, server entry point, or application route handler.
6. Create no Cache Rule that overrides the signed `Cache-Control` values and no Transform Rule that mutates a signed body or required header.
7. Create a least-privilege deployment API token scoped only to the QRWarden account and canonical zone. Set it through `CLOUDFLARE_API_TOKEN`; never place it in a command argument, source file, release artifact, or retained shell transcript.
8. Create or identify the account's single persistent Cloudflare Access application whose destination is `all_preview_workers`. Keep only a catch-all Block policy attached so unknown previews are denied. If the account is shared, coordinate with the existing application's owners instead of replacing it. Never attach a QRWarden Service Auth policy to this account-wide application because that would grant the release token access to unrelated Worker previews.
9. Once the first version upload creates the Worker and returns its immutable `worker_tag`, create a second persistent Access application with destination `preview_worker` for that exact Worker. Keep a catch-all Block policy attached. For each release window, add a short-lived Service Auth policy and token only to this QRWarden-specific application; Service Auth is evaluated before Block, and the specific destination takes precedence over the account-wide guard. Read back both persistent applications and their exact destinations before opening previews. Never delete either persistent application or its Block policy during routine QRWarden cleanup.

Read the response headers back from every preview and canonical hostname used in a release. `NEL`, `Report-To`, and `Reporting-Endpoints` must all be absent. The generated `_headers` file requests detachment, but it is not evidence that a platform-level reporting feature stayed disabled: Cloudflare can add headers after the static-asset layer. If any reporting header is present, stop, disable Network Error Logging or the equivalent account/zone feature, and repeat live verification until the exact response is free of reporting endpoints.

At steady state, `_qrwarden-release-key.<canonical-domain>` has exactly one TXT value: the 64-character lowercase SHA-256 fingerprint from `release/constants.json`. The logical TXT value has no prefix, whitespace, or embedded key material. DNSSEC validation is mandatory. A planned rotation temporarily publishes exactly the predecessor and successor fingerprints as separate values.

## Generated Wrangler configurations

After the canonical domain and release identity are committed, generate and review all seven configurations:

```sh
node scripts/release/render-wrangler-configs.mjs --write
npm run release:wrangler:check
```

Their roles are intentionally narrow:

| Configuration | Assets | Canonical domain | Preview URLs | Use |
| --- | --- | --- | --- | --- |
| `wrangler.jsonc` | enabled | attached | disabled | canonical production asset-upload shape |
| `wrangler.release.jsonc` | enabled | attached | enabled | repeat-release version upload |
| `wrangler.preview.jsonc` | enabled | absent | enabled | first-release version upload before launch |
| `wrangler.triggers.production.jsonc` | absent | attached | disabled | retain production, close previews, and inspect live state |
| `wrangler.triggers.release.jsonc` | absent | attached | enabled | repeat-release triggers, traffic deployment, and rollback |
| `wrangler.triggers.preview.jsonc` | absent | absent | enabled | first-release triggers and initial traffic deployment |
| `wrangler.triggers.closed.jsonc` | absent | absent | disabled | close previews only after the custom domain is confirmed absent |

Use the three asset-bearing configs only with `wrangler versions upload`. Use trigger-only configs with `wrangler triggers deploy` and with every version or deployment command that does not upload bytes. Trigger-only configs deliberately omit `assets`, so a clean verification machine never falls back to or validates a checkout-local `dist/`.

`wrangler triggers deploy` is currently experimental and is separate from `wrangler versions upload`. Always run its dry run, apply it, and then read back preview, workers.dev, and custom-domain state. Omitting `routes` does not detach a custom domain already present on Cloudflare; emergency unpublish must use the exact domain ID and the Workers Domains API procedure below. A configuration file is intent; Cloudflare's returned state is evidence.

## Release workspace and evidence

Use the repository-local Wrangler and an evidence directory outside the checkout:

```sh
set -o pipefail
set +x

W=./node_modules/.bin/wrangler
ACCOUNT_ID="$(jq -er '.cloudflare.accountId' release/constants.json)"
WORKER="$(jq -er '.product.workerName' release/constants.json)"
CANONICAL_DOMAIN="$(jq -er '.production.canonicalDomain' release/constants.json)"
VERSION=0.1.0
COMMIT=<40-lowercase-hex-release-commit>
RELEASE_ID="v$VERSION+$COMMIT"
ORIGIN="https://$CANONICAL_DOMAIN"
ARTIFACTS=<absolute-signed-artifact-directory>
STAGE=<absolute-empty-private-staging-directory>
EVIDENCE=<absolute-private-evidence-directory>

test "$($W --version)" = "4.111.0"
test -d "$ARTIFACTS"
test ! -e "$STAGE"
mkdir -m 700 "$STAGE" "$EVIDENCE"

cloudflare_api() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl --config - "$@"
}
```

Never enable shell xtrace in the release shell. The `cloudflare_api` helper streams the authorization header to curl over stdin; it does not expand the token into curl's process arguments or write it to a temporary file. Keep the Cloudflare token, Access service-token secret, zone ID, Access IDs, version IDs, deployment IDs, preview URLs, and Wrangler machine output outside public source. Use `WRANGLER_OUTPUT_FILE_PATH` for machine-readable Wrangler evidence.

## Verify and stage the signed dist

On a clean release-verification machine, verify the Minisign signatures and their trusted comments for the source archive, dist archive, dist-files manifest, and archive manifest. Regenerate and verify the archive manifest before extraction.

Inspect the signed tar before extracting it. It must contain exactly one `qrwarden-$VERSION-dist/` root; normalized relative UTF-8 paths; only directories and regular files; no duplicate paths, links, devices, absolute paths, `..`, or unexpected modes. Extract into the new private staging directory without restoring archive ownership or broader permissions, then rename the extracted root to `$STAGE/dist`.

Regenerate the manifest from the extracted tree and require byte equality with the signed manifest:

```sh
node scripts/release/generate-dist-files-manifest.mjs \
  --dist "$STAGE/dist" \
  --contract release/artifact-contract.json \
  --output "$STAGE/recomputed-dist-files.sha256"

cmp \
  "$ARTIFACTS/qrwarden-$VERSION-dist-files.sha256" \
  "$STAGE/recomputed-dist-files.sha256"
```

Do not modify `$STAGE/dist` after this comparison. Use that exact directory for upload and every live verification.

## Custom-domain evidence and mandatory detach

Immediately after every custom-domain attachment, capture the one exact domain object and retain its immutable ID:

```sh
DOMAIN_LIST="$EVIDENCE/custom-domain-attached.json"
cloudflare_api --fail-with-body --silent --show-error --get \
  --data-urlencode "hostname=$CANONICAL_DOMAIN" \
  --data-urlencode "service=$WORKER" \
  --output "$DOMAIN_LIST" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains"

jq -e '.success == true and (.errors | length == 0)' "$DOMAIN_LIST" >/dev/null
DOMAIN_ID="$(jq -er \
  --arg hostname "$CANONICAL_DOMAIN" \
  --arg service "$WORKER" \
  '[.result[] | select(.hostname == $hostname and .service == $service)] |
   select(length == 1) | .[0].id' \
  "$DOMAIN_LIST")"
```

Omission from a Wrangler config is not a detach operation. To abort a first launch or unpublish in an emergency, delete only the captured domain ID, require API success, and prove the exact hostname/service pair is absent:

```sh
cloudflare_api --fail-with-body --silent --show-error \
  --request DELETE \
  --output "$EVIDENCE/custom-domain-detach.json" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains/$DOMAIN_ID"

jq -e '.success == true and (.errors | length == 0)' \
  "$EVIDENCE/custom-domain-detach.json" >/dev/null

cloudflare_api --fail-with-body --silent --show-error --get \
  --data-urlencode "hostname=$CANONICAL_DOMAIN" \
  --data-urlencode "service=$WORKER" \
  --output "$EVIDENCE/custom-domain-after-detach.json" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains"

jq -e \
  --arg hostname "$CANONICAL_DOMAIN" \
  --arg service "$WORKER" \
  '.success == true and
   (.errors | length == 0) and
   ([.result[] | select(.hostname == $hostname and .service == $service)] | length == 0)' \
  "$EVIDENCE/custom-domain-after-detach.json" >/dev/null

"$W" triggers deploy -c wrangler.triggers.closed.jsonc --dry-run
"$W" triggers deploy -c wrangler.triggers.closed.jsonc
```

The final trigger commands close preview URLs after the API has removed the domain; they do not perform the detach themselves. Require `workers_dev == false`, previews disabled, and no matching custom domain on the final readback.

## First signed beta or rehearsal

The first deployment has no OLD Worker version. Its rollback is API detachment of the captured canonical-domain ID, not a claim that an earlier application version was restored.

1. Read back the persistent account-wide Access preview guard and its catch-all Block policy. It must have no QRWarden Service Auth policy.
2. Upload the signed candidate once without attaching the canonical domain:

   ```sh
   WRANGLER_OUTPUT_FILE_PATH="$EVIDENCE/first-upload.jsonl" \
   "$W" versions upload \
     -c wrangler.preview.jsonc \
     --assets "$STAGE/dist" \
     --strict \
     --tag "release-v$VERSION-$COMMIT" \
     --message "QRWarden v$VERSION commit $COMMIT"
   ```

3. Extract exactly one NEW version ID and `worker_tag` from the `version-upload` event. If Wrangler returns an ambiguous error, inspect `versions list -c wrangler.triggers.preview.jsonc --json` for the unique full tag before retrying. Never create a second version blindly. Create or read back the persistent QRWarden-specific `preview_worker` Access application for that exact `worker_tag`, verify its catch-all Block policy, and attach this release's short-lived Service Auth policy and token only to that application.
4. Enable route-less previews and read the state back:

   ```sh
   "$W" triggers deploy -c wrangler.triggers.preview.jsonc --dry-run
   "$W" triggers deploy -c wrangler.triggers.preview.jsonc
   ```

   Require `workers_dev == false`, previews enabled, and no custom domain. If the uploaded version has no discoverable version preview after this transition, stop the rehearsal; do not attach production. Rehearse that platform behavior before the signed launch window.

5. Verify the Access-protected preview. Access credentials come only from the paired environment variables:

   ```sh
   CF_ACCESS_CLIENT_ID="$ACCESS_CLIENT_ID" \
   CF_ACCESS_CLIENT_SECRET="$ACCESS_CLIENT_SECRET" \
   npm run release:verify:live -- \
     --origin "$PREVIEW" \
     --dist "$STAGE/dist" \
     --expected-release "$RELEASE_ID"
   ```

   Repeat without credentials and require denial. Do not accept a login page, Access error page, or redirect as an application response.

6. Deploy NEW at 100% while the canonical domain is still detached:

   ```sh
   WRANGLER_OUTPUT_FILE_PATH="$EVIDENCE/first-deployment.jsonl" \
   "$W" versions deploy \
     "$NEW@100%" \
     -c wrangler.triggers.preview.jsonc \
     --message "Prepare first QRWarden beta" \
     --yes
   ```

   Poll `deployments status --json` until exactly NEW at 100% is reported.

7. Attach the canonical domain only after the preview passes:

   ```sh
   "$W" triggers deploy -c wrangler.triggers.release.jsonc --dry-run
   "$W" triggers deploy -c wrangler.triggers.release.jsonc
   ```

   Read back `workers_dev == false`, previews enabled, and exactly one custom domain matching the canonical hostname and `qrwarden`. Capture and validate its immutable domain ID using the procedure above, then wait for DNS and certificate readiness.

8. Verify ordinary canonical traffic against the same signed tree:

   ```sh
   npm run release:verify:live -- \
     --origin "$ORIGIN" \
     --dist "$STAGE/dist" \
     --expected-release "$RELEASE_ID"
   ```

9. Complete fresh-profile, installed-PWA, offline, update, camera, image, no-egress, and physical-device checks. If any check fails, immediately run the mandatory API detach procedure above with the captured `DOMAIN_ID`; do not rely on an empty Wrangler route list. Read back that previews and the exact custom domain are absent before continuing.

10. On success, disable previews while retaining production:

    ```sh
    "$W" triggers deploy -c wrangler.triggers.production.jsonc --dry-run
    "$W" triggers deploy -c wrangler.triggers.production.jsonc
    ```

    Verify production again after cleanup. This signed beta can become OLD for the next release; it does not retroactively make its own first launch a stable-v1 rollback drill.

## Repeat release with OLD and NEW

1. Using `wrangler.triggers.production.jsonc`, capture `deployments status --json` and require exactly one OLD version at 100%. Capture `versions view "$OLD" --json` and the custom-domain state with the same asset-free config.
2. Extract the prior signed release into a separate staging directory and run `release:verify:live` against ordinary production. Stop if live OLD differs from its signed bytes or headers.
3. Read back both persistent Access guards and their Block policies. Attach this release's short-lived Service Auth policy and token only to the QRWarden-specific `preview_worker` application.
4. Enable previews without changing the existing custom domain:

   ```sh
   "$W" triggers deploy -c wrangler.triggers.release.jsonc --dry-run
   "$W" triggers deploy -c wrangler.triggers.release.jsonc
   ```

   Require `workers_dev == false`, previews enabled, and the unchanged canonical custom domain.

5. Upload the exact staged candidate once:

   ```sh
   WRANGLER_OUTPUT_FILE_PATH="$EVIDENCE/upload.jsonl" \
   "$W" versions upload \
     -c wrangler.release.jsonc \
     --assets "$STAGE/dist" \
     --strict \
     --tag "release-v$VERSION-$COMMIT" \
     --message "QRWarden v$VERSION commit $COMMIT"
   ```

6. Extract exactly one NEW version ID and protected preview URL from the machine-readable output. If inspection is needed, use `versions list -c wrangler.triggers.release.jsonc --json`. Verify the preview with Access and the signed tree, then require denial without Access credentials.
7. Create the explicit zero-percent deployment:

   ```sh
   WRANGLER_OUTPUT_FILE_PATH="$EVIDENCE/split.jsonl" \
   "$W" versions deploy \
     "$OLD@100%" \
     "$NEW@0%" \
     -c wrangler.triggers.release.jsonc \
     --message "Stage QRWarden v$VERSION at zero percent" \
     --yes
   ```

   Poll until Cloudflare reports exactly OLD 100% and NEW 0%. A version override is valid only after NEW appears in the active deployment, and propagation may lag briefly.

8. Verify NEW through the canonical domain and exact version override:

   ```sh
   npm run release:verify:live -- \
     --origin "$ORIGIN" \
     --dist "$STAGE/dist" \
     --expected-release "$RELEASE_ID" \
     --worker-name "$WORKER" \
     --version-id "$NEW"
   ```

   The verifier's exact release marker and body checks detect a malformed or unavailable override that silently falls back to OLD.

9. Immediately before promotion, reverify that ordinary traffic still matches OLD. Then promote NEW:

   ```sh
   WRANGLER_OUTPUT_FILE_PATH="$EVIDENCE/promotion.jsonl" \
   "$W" versions deploy \
     "$NEW@100%" \
     -c wrangler.triggers.release.jsonc \
     --message "Promote QRWarden v$VERSION" \
     --yes
   ```

10. Poll until exactly NEW at 100% is active. Run `release:verify:live` without an override, followed by the complete fresh-profile, installed/offline, update, permission, lifecycle, physical-device, and no-egress gates.

## Repeat-release rollback

Before or after promotion, restore the independently verified OLD version deterministically with `versions deploy`; do not use an interactive rollback shortcut:

```sh
"$W" versions deploy \
  "$OLD@100%" \
  -c wrangler.triggers.release.jsonc \
  --message "Rollback QRWarden v$VERSION" \
  --yes
```

Poll until exactly OLD at 100%, then byte-verify ordinary production against OLD's signed dist. If NEW's service worker reached any client, infrastructure rollback is not complete remediation; build and publish a forward corrective release.

## Cleanup and final publication

After successful promotion or a verified rollback:

1. Apply `wrangler.triggers.production.jsonc` to retain the canonical domain while disabling preview URLs. If the first launch was aborted after attachment, run the mandatory domain-ID deletion and readback first, then apply `wrangler.triggers.closed.jsonc`.
2. Read back workers.dev, preview, deployment, custom-domain, and live response-header state. Confirm the preview URL no longer serves candidate bytes and that canonical responses still omit `NEL`, `Report-To`, and `Reporting-Endpoints`.
3. Remove only the release-window Service Auth policy from the QRWarden-specific application, then revoke its ephemeral service token. Unset the Cloudflare and Access token environment variables and remove the `cloudflare_api` shell function. Keep both persistent Access applications and both catch-all Block policies in place, and read them back after cleanup.
4. Preserve version, deployment, domain, Access, Wrangler machine-output, live-verification, DNSSEC, TLS, and cleanup evidence outside the public repository. Do not retain secrets.
5. Arm the external drift watchdog and verify it detects a deliberately wrong expected release ID without logging response bodies or credentials.
6. Publish the immutable GitHub release and tag only after final production verification and cleanup succeed. Never replace an existing release, asset, signature, or tag.
