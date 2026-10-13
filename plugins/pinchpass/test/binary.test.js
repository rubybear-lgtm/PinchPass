import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIN_VALID_BYTES, binaryVersion, compareVersions, findBinaryIn, packageVersion, parseVersion, updateNotice } from "../dist/binary.js";

const posixOnly = process.platform === "win32" ? { skip: "POSIX executable bits" } : {};

function makeExecutable(dir, name, bytes) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, Buffer.alloc(bytes));
  chmodSync(file, 0o755);
  return file;
}

test("prefers a real binary over an earlier broken stub", posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "pinchpass-bin-"));
  try {
    const stubDir = join(root, "stub");
    const realDir = join(root, "real");
    makeExecutable(stubDir, "pinchpass", 16);
    const real = makeExecutable(realDir, "pinchpass", MIN_VALID_BYTES);

    assert.equal(findBinaryIn([stubDir, realDir], "linux"), real);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to a stub when nothing else matches", posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "pinchpass-bin-"));
  try {
    const stubDir = join(root, "stub");
    const stub = makeExecutable(stubDir, "pinchpass", 16);
    assert.equal(findBinaryIn([stubDir], "linux"), stub);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns null when no candidate is executable", posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "pinchpass-bin-"));
  try {
    assert.equal(findBinaryIn([join(root, "missing")], "linux"), null);
    assert.equal(findBinaryIn([], "linux"), null);
    const dir = join(root, "noexec");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pinchpass"), Buffer.alloc(MIN_VALID_BYTES));
    chmodSync(join(dir, "pinchpass"), 0o644);
    assert.equal(findBinaryIn([dir], "linux"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deduplicates directories and honors the Windows binary name", posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "pinchpass-bin-"));
  try {
    const dir = join(root, "win");
    const file = makeExecutable(dir, "pinchpass.exe", MIN_VALID_BYTES);
    assert.equal(findBinaryIn([dir, dir, dir], "win32"), file);
    assert.equal(findBinaryIn([dir], "linux"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeVersionBinary(dir, body) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pinchpass");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test("packageVersion reads this package's version", () => {
  assert.match(packageVersion() ?? "", /^\d+\.\d+\.\d+$/);
});

test("parseVersion and compareVersions handle release vs dev output", () => {
  assert.equal(parseVersion("pinchpass v1.2.0 (abc1234)"), "1.2.0");
  assert.equal(parseVersion("pinchpass v1.1.2-0.20261013-89ce5d6+dirty (89ce5d6)"), null);
  assert.equal(compareVersions("1.1.0", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("1.3.0", "1.2.0"), 1);
});

test("updateNotice flags an older binary and clears a current one", posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "pinchpass-notice-"));
  try {
    const pkg = packageVersion();
    assert.ok(pkg, "package version must be readable");

    const old = fakeVersionBinary(join(root, "old"), 'echo "pinchpass v0.0.1"');
    assert.match(updateNotice(old) ?? "", /older than this package/);

    const current = fakeVersionBinary(join(root, "current"), `echo "pinchpass v${pkg} (abc1234)"`);
    assert.equal(updateNotice(current), null);

    const silent = fakeVersionBinary(join(root, "silent"), "exit 1");
    assert.match(updateNotice(silent) ?? "", /predates version reporting/);
    assert.equal(binaryVersion(silent), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
