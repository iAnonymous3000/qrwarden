import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const roots = ["src", "decoder-worker"];
const failures = [];
const universalRules = [
  [/\bdangerouslySetInnerHTML\b/, "dangerouslySetInnerHTML is forbidden"],
  [/\.(?:innerHTML|outerHTML)\b/, "HTML assignment sinks are forbidden"],
  [/\.insertAdjacentHTML\s*\(/, "insertAdjacentHTML is forbidden"],
  [/\bdocument\.(?:write|writeln)\s*\(/, "document.write is forbidden"],
  [/\bnew\s+DOMParser\s*\(/, "DOMParser construction is forbidden"],
  [/\b(?:eval|Function)\s*\(/, "dynamic code execution is forbidden"],
  [/\bnew\s+Function\b/, "new Function is forbidden"],
  [/\bwindow\.open\s*\(/, "window.open is forbidden"],
  [/\.(?:setProperty|insertRule)\s*\(/, "runtime CSSOM mutation is forbidden"],
  [/\bconsole\.[a-zA-Z]+\s*\(/, "console output is forbidden"],
  [/<[^>]+\sstyle\s*=/, "inline style attributes are forbidden"],
  [/\bstyle\s*=\s*\{/, "Preact style props are forbidden"],
  [/\.(?:style)\s*(?:=|\.)/, "element.style mutation is forbidden"],
  [/\bjavascript\s*:/i, "javascript URLs are forbidden"],
  [/<(?:link|script)[^>]+rel=["'](?:prefetch|preconnect|dns-prefetch|prerender)["']/i, "speculative resource hints are forbidden"],
  [/<[^>]+\s(?:href|src|action|poster|data|srcset)\s*=\s*\{/, "dynamic live resource attributes are forbidden"],
  [/\bnavigator\.clipboard\.read(?:Text)?\s*\(/, "clipboard reads are forbidden"],
];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collect(target)));
    else if (/\.tsx?$/.test(entry.name)) output.push(target);
  }
  return output;
}

function locate(text, index) {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

for (const root of roots) {
  for (const file of await collect(root)) {
    const text = await readFile(file, "utf8");
    const rules = [...universalRules];
    if (file.startsWith(`src${path.sep}analyzer${path.sep}`)) {
      rules.push(
        [/\.normalize\s*\(/, "host-versioned Unicode normalization is forbidden in the analyzer"],
        [/\\[pP]\{/, "host-versioned Unicode property escapes are forbidden in the analyzer"],
      );
    }
    if (!file.startsWith(`src${path.sep}sw${path.sep}`) && !file.startsWith(`decoder-worker${path.sep}`)) {
      rules.push([/\bWebAssembly\b/, "WebAssembly is forbidden in document code"]);
    }
    for (const [pattern, message] of rules) {
      const match = pattern.exec(text);
      if (match !== null) {
        const location = locate(text, match.index);
        failures.push(`${file}:${location.line}:${location.column} ${message}`);
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}
