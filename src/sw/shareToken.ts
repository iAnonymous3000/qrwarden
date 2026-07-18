export const SHARE_PENDING_PARAMETER = "share-pending";

const SHARE_PENDING_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export function isSharePendingToken(value: unknown): value is string {
  return (
    typeof value === "string" && SHARE_PENDING_TOKEN_PATTERN.test(value)
  );
}

/**
 * Returns the one valid share capability carried by a redirect URL.
 * Duplicate or companion parameters are rejected so an ambiguous URL can
 * never claim a worker-memory payload.
 */
export function sharePendingTokenFromUrl(url: URL): string | null {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== SHARE_PENDING_PARAMETER ||
    !isSharePendingToken(entries[0]?.[1])
  ) {
    return null;
  }
  return entries[0][1];
}

export function sharePendingLocation(token: string): string {
  if (!isSharePendingToken(token)) {
    throw new TypeError("Invalid share-pending token");
  }
  return `/?${SHARE_PENDING_PARAMETER}=${token}`;
}
