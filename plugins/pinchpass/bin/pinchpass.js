#!/usr/bin/env node
/**
 * `pinchpass` CLI entry point.
 *
 * npm installs this file as the package's `bin`, so `npx @pinchpass/cli` and a
 * global install behave like a normal npm CLI. It resolves the platform binary
 * (downloading it on first use) and hands off to it, forwarding stdio, signals,
 * and the exit code.
 *
 * It deliberately does not re-check the binary version on every run: keeping
 * updates in `npm update -g` / `brew upgrade` keeps `pinchpass request` fast
 * and predictable.
 */
import { spawn } from "node:child_process";

let findBinary;
let install;
try {
  const [binaryMod, installerMod] = await Promise.all([
    import("../dist/binary.js"),
    import("../scripts/install-binary.js"),
  ]);
  findBinary = binaryMod.findBinary;
  install = installerMod.install;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pinchpass: package is not built (${message})\n`);
  process.stderr.write("pinchpass: run `npm run build` in the package directory.\n");
  process.exit(1);
}

async function resolveBinary() {
  const existing = findBinary();
  if (existing) return existing;

  process.stderr.write("pinchpass: downloading the platform binary...\n");
  await install({ log: (line) => process.stderr.write(`${line}\n`) });
  return findBinary();
}

const binary = await resolveBinary();
if (!binary) {
  process.stderr.write(
    "pinchpass: could not find or install the binary.\n" +
      "pinchpass: install it with `npm i -g @pinchpass/cli` or " +
      "`go install github.com/rubybear-lgtm/pinchpass@latest`.\n",
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  });
}

child.on("error", (err) => {
  process.stderr.write(`pinchpass: failed to run ${binary}: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
