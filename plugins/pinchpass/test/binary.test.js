import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIN_VALID_BYTES, findBinaryIn } from "../dist/binary.js";

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
