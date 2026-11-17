// Run the Worker's tests under Node: bundle each test/*.test.ts with esbuild (the Worker's
// imports have no file extensions, which Node's own type stripping can't resolve), keep npm
// packages external so they load from worker/node_modules, then run them with node --test.
//   npm --prefix worker test
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", ".test-build");
const tests = readdirSync(here).filter((f) => f.endsWith(".test.ts")).map((f) => join(here, f));

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: tests,
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
const files = readdirSync(out).map((f) => join(out, f));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
