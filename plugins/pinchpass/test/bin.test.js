import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(packageRoot, "bin", "pinchpass.js");

const posixOnly = process.platform === "win32" ? { skip: "POSIX shell shim" } : {};

test("package.json exposes the pinchpass bin and ships it", () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.bin?.pinchpass, "./bin/pinchpass.js");
  assert.ok(pkg.files.includes("bin"), "bin/ must be published");

  assert.ok(existsSync(launcher), "bin/pinchpass.js must exist");
  assert.match(readFileSync(launcher, "utf8"), /^#!\/usr\/bin\/env node/);
  if (process.platform !== "win32") {
    assert.ok(statSync(launcher).mode & 0o111, "bin/pinchpass.js must be executable");
  }
});

test("launcher resolves the binary and forwards args and exit code", posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "pinchpass-bin-"));
  try {
    // A shim large enough to satisfy the >=100 KB "real binary" check, so it
    // wins over any pinchpass already installed on this machine.
    const shim = join(root, "pinchpass");
    mkdirSync(root, { recursive: true });
    writeFileSync(shim, `#!/bin/sh\n#${"x".repeat(110 * 1024)}\necho "fake-args: $*"\nexit 7\n`);
    chmodSync(shim, 0o755);

    const run = (args) => {
      try {
        const out = execFileSync(process.execPath, [launcher, ...args], {
          env: { ...process.env, PATH: root },
          encoding: "utf8",
        });
        return { code: 0, out };
      } catch (err) {
        return { code: err.status, out: err.stdout ?? "" };
      }
    };

    const ok = run(["hello", "--world"]);
    assert.equal(ok.out.trim(), "fake-args: hello --world");
    assert.equal(ok.code, 7, "launcher must propagate the child's exit code");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
