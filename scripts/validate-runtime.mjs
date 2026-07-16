import { execFileSync } from "node:child_process";
import process from "node:process";

const expectedNode = "v24.18.0";
const expectedNpm = "11.16.0";
const npmVersion = execFileSync("npm", ["--version"], {
  encoding: "utf8",
}).trim();

const errors = [];
if (process.version !== expectedNode) {
  errors.push(`Node.js must be exactly ${expectedNode}, received ${process.version}`);
}
if (npmVersion !== expectedNpm) {
  errors.push(`npm must be exactly ${expectedNpm}, received ${npmVersion}`);
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`runtime: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`runtime is exact: Node.js ${expectedNode}, npm ${expectedNpm}\n`);
}
