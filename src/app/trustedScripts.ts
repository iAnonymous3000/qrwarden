export interface QrwardenTrustedScriptURL {
  readonly __qrwardenTrustedScriptURL: never;
}

interface TrustedTypePolicyLike {
  createScriptURL(input: string): QrwardenTrustedScriptURL;
}

interface TrustedTypePolicyFactoryLike {
  createPolicy(
    name: "qrwarden-script-url",
    rules: { readonly createScriptURL: (input: string) => string },
  ): TrustedTypePolicyLike;
}

declare global {
  interface Window {
    readonly trustedTypes?: TrustedTypePolicyFactoryLike;
  }

  interface WorkerConstructor {
    new (
      scriptURL: string | URL | QrwardenTrustedScriptURL,
      options?: WorkerOptions,
    ): Worker;
  }

  interface ServiceWorkerContainer {
    register(
      scriptURL: string | URL | QrwardenTrustedScriptURL,
      options?: RegistrationOptions,
    ): Promise<ServiceWorkerRegistration>;
  }
}

export interface TrustedWorkerScripts {
  readonly decoder: string | QrwardenTrustedScriptURL;
  readonly serviceWorker: string | QrwardenTrustedScriptURL;
  readonly trustedTypes: "enforced" | "unsupported";
}

let scripts: TrustedWorkerScripts | null = null;

function validatePath(input: string): string {
  if (input !== "/decoder-worker.js" && input !== "/sw.js") {
    throw new TypeError("Rejected worker script path");
  }
  const parsed = new URL(input, location.origin);
  if (
    parsed.href !== `${location.origin}${input}` ||
    parsed.origin !== location.origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("Rejected worker script URL");
  }
  return input;
}

export function initializeTrustedWorkerScripts(): TrustedWorkerScripts {
  if (scripts !== null) {
    return scripts;
  }
  if (window.trustedTypes === undefined) {
    scripts = Object.freeze({
      decoder: validatePath("/decoder-worker.js"),
      serviceWorker: validatePath("/sw.js"),
      trustedTypes: "unsupported" as const,
    });
    return scripts;
  }

  const policy = window.trustedTypes.createPolicy("qrwarden-script-url", {
    createScriptURL: validatePath,
  });
  scripts = Object.freeze({
    decoder: policy.createScriptURL("/decoder-worker.js"),
    serviceWorker: policy.createScriptURL("/sw.js"),
    trustedTypes: "enforced" as const,
  });
  return scripts;
}

export function createQrwardenModuleWorker(
  scriptURL: string | QrwardenTrustedScriptURL,
): Worker {
  const TrustedWorker = Worker as unknown as new (
    scriptURL: string | QrwardenTrustedScriptURL,
    options: WorkerOptions,
  ) => Worker;
  return new TrustedWorker(scriptURL, {
    type: "module",
    name: "qrwarden-decoder",
  });
}
