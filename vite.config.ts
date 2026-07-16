import preact from "@preact/preset-vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// The application requests the decoder worker only at the fixed production
// path validated by trustedScripts. The dev server has no such emitted chunk,
// so serve a module shim that loads the worker source through Vite instead.
function devDecoderWorkerEndpoint(): Plugin {
  return {
    name: "qrwarden-dev-decoder-worker",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] === "/decoder-worker.js") {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end('import "/decoder-worker/index.ts";\n');
          return;
        }
        next();
      });
    },
  };
}

const developmentCommit = "0000000000000000000000000000000000000000";
const commit = process.env.QRWARDEN_COMMIT ?? developmentCommit;
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new TypeError(
    "QRWARDEN_COMMIT must be exactly 40 lowercase hexadecimal characters",
  );
}
const version = process.env.npm_package_version ?? "0.1.0";
const releaseId = `v${version}+${commit}`;
const root = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));
const releaseConstants = JSON.parse(
  readFileSync(root("./release/constants.json"), "utf8"),
) as {
  readonly production: { readonly dnsReleaseKeyOwner: string };
  readonly github: { readonly owner: string; readonly repository: string };
  readonly signing: {
    readonly minisignPublicKey: string;
    readonly sha256Fingerprint: string;
  };
};
const sourceRepository =
  /^[A-Za-z0-9-]+$/.test(releaseConstants.github.owner) &&
  /^[A-Za-z0-9._-]+$/.test(releaseConstants.github.repository)
    ? `https://github.com/${releaseConstants.github.owner}/${releaseConstants.github.repository}`
    : null;

export default defineConfig({
  plugins: [preact(), devDecoderWorkerEndpoint()],
  publicDir: "public",
  define: {
    __QRWARDEN_RELEASE_ID__: JSON.stringify(releaseId),
    __QRWARDEN_PREVIOUS_CACHE__: JSON.stringify(
      process.env.QRWARDEN_PREVIOUS_CACHE ?? null,
    ),
    __QRWARDEN_SIGNING_PUBLIC_KEY__: JSON.stringify(
      releaseConstants.signing.minisignPublicKey,
    ),
    __QRWARDEN_SIGNING_FINGERPRINT__: JSON.stringify(
      releaseConstants.signing.sha256Fingerprint,
    ),
    __QRWARDEN_DNS_KEY_OWNER__: JSON.stringify(
      releaseConstants.production.dnsReleaseKeyOwner,
    ),
    __QRWARDEN_SOURCE_REPOSITORY__: JSON.stringify(sourceRepository),
  },
  build: {
    assetsInlineLimit: 0,
    cssCodeSplit: true,
    emptyOutDir: true,
    modulePreload: false,
    reportCompressedSize: false,
    sourcemap: false,
    // iOS browsers all use WebKit. This matches the first WebKit release with
    // the worker OffscreenCanvas support required by the decoder.
    target: "safari16.4",
    rollupOptions: {
      input: {
        app: root("./index.html"),
        "decoder-worker": root("./decoder-worker/index.ts"),
        sw: root("./src/sw/service-worker.ts"),
      },
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".wasm"))
            ? "assets/reader-[hash][extname]"
            : "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === "decoder-worker") return "decoder-worker.js";
          if (chunkInfo.name === "sw") return "sw.js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
