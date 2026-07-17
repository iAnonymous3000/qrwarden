import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DIST = path.resolve("dist");
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "4173", 10);

const mediaTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".pub", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json"],
]);

function parseHeaderRules(source) {
  const rules = [];
  let current = null;
  for (const line of source.split("\n")) {
    if (line.length === 0) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line, headers: [] };
      rules.push(current);
      continue;
    }
    if (current === null) throw new Error("_headers begins with an orphan header");
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`invalid _headers line: ${line}`);
    current.headers.push([
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    ]);
  }
  return rules;
}

function routeMatches(pattern, pathname) {
  if (pattern === "/*") return true;
  if (pattern.endsWith("*")) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern;
}

function safeRelativePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  return decoded.slice(1);
}

const headerRules = parseHeaderRules(
  await readFile(path.join(DIST, "_headers"), "utf8"),
);

function applyContractHeaders(response, pathname) {
  for (const rule of headerRules) {
    if (!routeMatches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) response.setHeader(name, value);
  }
}

function sendText(response, requestMethod, status, text) {
  const bytes = Buffer.from(text, "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", String(bytes.byteLength));
  response.end(requestMethod === "HEAD" ? undefined : bytes);
}

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendText(response, method, 405, "Method not allowed\n");
    return;
  }

  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  applyContractHeaders(response, pathname);

  if (pathname === "/index.html" && url.search === "") {
    response.statusCode = 307;
    response.setHeader("Location", "/");
    response.setHeader("Content-Length", "0");
    response.end();
    return;
  }
  if (pathname === "/_headers") {
    sendText(response, method, 404, "Not found\n");
    return;
  }

  const relative = pathname === "/" ? "index.html" : safeRelativePath(pathname);
  if (relative === null || relative.length === 0) {
    sendText(response, method, 404, "Not found\n");
    return;
  }
  const absolute = path.resolve(DIST, relative);
  if (!absolute.startsWith(`${DIST}${path.sep}`)) {
    sendText(response, method, 404, "Not found\n");
    return;
  }

  try {
    const details = await stat(absolute);
    if (!details.isFile()) throw new Error("not a regular file");
    const bytes = await readFile(absolute);
    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      mediaTypes.get(path.extname(absolute)) ?? "application/octet-stream",
    );
    response.setHeader("Content-Length", String(bytes.byteLength));
    response.end(method === "HEAD" ? undefined : bytes);
  } catch {
    sendText(response, method, 404, "Not found\n");
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`serving verified dist at http://${HOST}:${PORT}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
