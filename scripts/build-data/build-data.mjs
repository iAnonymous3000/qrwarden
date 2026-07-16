import { buildIanaSpecialPurposeSnapshot } from "./iana-special-purpose.mjs";
import { buildPublicSuffixSnapshot } from "./public-suffix.mjs";
import {
  assertExactKeys,
  invariant,
  isDirectExecution,
  readJsonFile,
} from "./shared.mjs";
import { buildUnicodeSnapshot } from "./unicode.mjs";

const DATA_STATUS_URL = new URL("../../release/data-status.json", import.meta.url);
const UNICODE_PROVENANCE_URL = new URL(
  "../../data-src/unicode/provenance.json",
  import.meta.url,
);

function validateDataStatus(status, psl, iana, unicode, unicodeProvenance) {
  assertExactKeys(
    status,
    ["schemaVersion", "releaseReady", "publicSuffix", "ianaSpecialPurpose", "unicodeSecurity"],
    "release data status",
  );
  invariant(status.schemaVersion === 1, "release data status schemaVersion must be 1");
  invariant(status.releaseReady === true, "all analyzer data must be release-ready");

  assertExactKeys(
    status.publicSuffix,
    ["captured", "sourceCommit", "completeness"],
    "release PSL status",
  );
  invariant(
    status.publicSuffix.captured === psl.provenance.captured,
    "release PSL capture date does not match provenance",
  );
  invariant(
    status.publicSuffix.sourceCommit === psl.provenance.sourceCommit,
    "release PSL commit does not match provenance",
  );
  invariant(status.publicSuffix.completeness === "complete", "release PSL status is not complete");

  assertExactKeys(
    status.ianaSpecialPurpose,
    ["captured", "sourceVersion", "completeness"],
    "release IANA status",
  );
  const ipv4Version = iana.files.get("ipv4-special-csv").sourceVersion;
  const ipv6Version = iana.files.get("ipv6-special-csv").sourceVersion;
  invariant(ipv4Version === ipv6Version, "IANA IPv4 and IPv6 special-purpose versions differ");
  invariant(
    status.ianaSpecialPurpose.captured === iana.provenance.captured,
    "release IANA capture date does not match provenance",
  );
  invariant(
    status.ianaSpecialPurpose.sourceVersion === ipv4Version,
    "release IANA version does not match provenance",
  );
  invariant(
    status.ianaSpecialPurpose.completeness === "complete",
    "release IANA status is not complete",
  );

  assertExactKeys(
    status.unicodeSecurity,
    ["captured", "unicodeVersion", "sourceSha256", "completeness"],
    "release Unicode status",
  );
  invariant(
    status.unicodeSecurity.captured === unicodeProvenance.captured,
    "release Unicode capture date does not match provenance",
  );
  invariant(
    status.unicodeSecurity.unicodeVersion === unicodeProvenance.unicodeVersion,
    "release Unicode version does not match provenance",
  );
  invariant(
    status.unicodeSecurity.sourceSha256 === unicodeProvenance.sourceSetSha256 &&
      status.unicodeSecurity.sourceSha256 === unicode.sourceSetSha256,
    "release Unicode source-set hash does not match provenance",
  );
  invariant(
    status.unicodeSecurity.completeness === "complete",
    "release Unicode status is not complete",
  );
}

export async function buildAllDataSnapshots({ check = false } = {}) {
  const [psl, iana, unicode, unicodeProvenance, status] = await Promise.all([
    buildPublicSuffixSnapshot({ check }),
    buildIanaSpecialPurposeSnapshot({ check }),
    buildUnicodeSnapshot({ check }),
    readJsonFile(UNICODE_PROVENANCE_URL, "Unicode provenance"),
    readJsonFile(DATA_STATUS_URL, "release data status"),
  ]);
  validateDataStatus(status, psl, iana, unicode, unicodeProvenance);
  return { psl, iana, unicode };
}

export async function runDataCommand(arguments_, command = "build-data.mjs") {
  if (arguments_.some((argument) => argument !== "--check") || arguments_.length > 1) {
    throw new Error(`usage: node scripts/build-data/${command} [--check]`);
  }
  const check = arguments_[0] === "--check";
  const { psl, iana, unicode } = await buildAllDataSnapshots({ check });
  const pslRules =
    psl.icannRules.length +
    psl.privateRules.length +
    psl.wildcardRules.length +
    psl.privateWildcardRules.length +
    psl.exceptionRules.length +
    psl.privateExceptionRules.length;

  process.stdout.write(
    `${check ? "verified" : "generated"} pinned analyzer data (${pslRules} PSL rules; ${iana.ipv4.length + iana.ipv6.length} IP ranges; ${unicode.packedByteLength} packed Unicode bytes)\n`,
  );
}

if (isDirectExecution(import.meta.url)) {
  await runDataCommand(process.argv.slice(2));
}
