import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const serveDist = fileURLToPath(
  new URL("../../scripts/serve-dist.mjs", import.meta.url),
);

it.each(["NEL", "Report-To", "reporting-endpoints"])(
  "fails local dist-server startup on forbidden %s expectations",
  async (name) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qrwarden-serve-dist-"));
    try {
      const dist = path.join(root, "dist");
      await mkdir(dist);
      await writeFile(
        path.join(dist, "_headers"),
        `/*\n  ${name}: cf-nel\n`,
        "utf8",
      );

      const result = spawnSync(process.execPath, [serveDist], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `reporting header ${name} is forbidden in _headers at line 2`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
