import { build } from "esbuild";

const entryPoints = {
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
  entryPoints: { action: entryPoints.action },
});

await build({
  ...shared,
  entryPoints: { cli: entryPoints.cli },
  banner: { js: "#!/usr/bin/env node" },
});
