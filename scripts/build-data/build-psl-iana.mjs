// Compatibility entry point retained for older local commands. All analyzer
// datasets now advance and validate as one release-status unit.
import { runDataCommand } from "./build-data.mjs";

await runDataCommand(process.argv.slice(2), "build-psl-iana.mjs");
