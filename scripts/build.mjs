import { build } from "esbuild";

const entryPoints = {
  "planner-server": "src/entry/planner-server.ts",
  action: "src/entry/action.ts",
  cli: "src/entry/cli.ts",
};

const shared = {
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  packages: "external",
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: { "planner-server": entryPoints["planner-server"], action: entryPoints.action },
});

await build({
  ...shared,
  entryPoints: { cli: entryPoints.cli },
  banner: { js: "#!/usr/bin/env node" },
});
