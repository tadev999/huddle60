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

// Node built-ins used by CLI helpers; the browser engine never calls them.
const NODE_STUB_EXPORTS = [
  "execFile",
  "execFileSync",
  "existsSync",
  "readFileSync",
  "mkdir",
  "readFile",
  "writeFile",
  "readdir",
  "appendFile",
  "homedir",
  "join",
  "dirname",
  "relative",
];

const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "node-stub" }, (args) => ({
      contents: NODE_STUB_EXPORTS.map(
        (name) =>
          `export const ${name} = () => { throw new Error("${args.path} is not available in the browser"); };`,
      ).join("\n"),
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["src/web/main.ts"],
  outfile: "ui/engine.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  minify: true,
  sourcemap: true,
  logLevel: "info",
  define: { "process.env": "{}", "process.platform": '"browser"' },
  plugins: [stubNodeBuiltins],
});
