import { readFile } from "node:fs/promises";

const source = new URL("../release/permissions-policy.json", import.meta.url);
const registry = JSON.parse(await readFile(source, "utf8"));
const value = registry.directives
  .map(({ name, allow }) => `${name}=(${allow === "self" ? "self" : ""})`)
  .join(", ");

process.stdout.write(`${value}\n`);
