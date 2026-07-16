export interface CommitMessageTarget {
  postMessage(message: Readonly<Record<string, string>>): void;
}

/**
 * skipWaiting crosses the activation-request boundary. Once it resolves,
 * notification is best-effort and can no longer turn the transaction into a
 * reported failure; clients reconcile through controllerchange/watchdogs.
 */
export async function requestActivationCommit(
  skipWaiting: () => Promise<void>,
  clients: readonly CommitMessageTarget[],
  message: Readonly<Record<string, string>>,
): Promise<boolean> {
  try {
    await skipWaiting();
  } catch {
    return false;
  }

  for (const client of clients) {
    try {
      client.postMessage(message);
    } catch {
      // Activation was requested already; this client will reconcile locally.
    }
  }
  return true;
}
