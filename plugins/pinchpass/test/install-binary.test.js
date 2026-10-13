import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assetName,
  checksumFor,
  compareVersions,
  findExisting,
  packageVersion,
  parseVersion,
  readBinaryVersion,
  verifyChecksum,
} from "../scripts/install-binary.js";

test("packageVersion reads the published version", () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+$/);
});

test("assetName maps each platform to its release asset", () => {
  assert.equal(assetName("darwin", "arm64"), "pinchpass-darwin-arm64");
  assert.equal(assetName("linux", "x64"), "pinchpass-linux-amd64");
  assert.equal(assetName("linux", "arm64"), "pinchpass-linux-arm64");
  assert.equal(assetName("win32", "x64"), "pinchpass-windows-amd64");
  assert.throws(() => assetName("freebsd", "x64"), /Unsupported platform/);
});

test("parseVersion accepts release output and rejects dev/unknown output", () => {
  assert.equal(parseVersion("pinchpass v1.2.0 (abc1234)"), "1.2.0");
  assert.equal(parseVersion("pinchpass 1.2.0"), "1.2.0");
  assert.equal(parseVersion("pinchpass v1.1.2-0.20261013022051-89ce5d6dc450+dirty (89ce5d6)"), null);
  assert.equal(parseVersion("Unknown command: --version"), null);
  assert.equal(parseVersion(""), null);
});

test("compareVersions orders x.y.z numerically", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.1.9", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
});

test("checksumFor picks the matching asset line", () => {
  const body = `${"a".repeat(64)}  pinchpass-linux-amd64\n${"b".repeat(64)}  pinchpass-darwin-arm64\n`;
  assert.equal(checksumFor(body, "pinchpass-darwin-arm64"), "b".repeat(64));
  assert.equal(checksumFor(body, "pinchpass-windows-amd64"), null);
  assert.equal(checksumFor("not-a-checksum  pinchpass-linux-amd64", "pinchpass-linux-amd64"), null);
});

test("verifyChecksum verifies, reports missing, and rejects mismatches", async () => {
  const bytes = Buffer.from("binary");
  const good = createHash("sha256").update(bytes).digest("hex");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, text: async () => `${good}  pinchpass-linux-amd64\n` });
    assert.equal(await verifyChecksum("pinchpass-linux-amd64", bytes, "https://example.test"), "verified");

    globalThis.fetch = async () => ({ ok: true, text: async () => `unparseable  pinchpass-linux-amd64\n` });
    assert.equal(await verifyChecksum("pinchpass-linux-amd64", bytes, "https://example.test"), "missing");

    globalThis.fetch = async () => ({ ok: true, text: async () => `${"0".repeat(64)}  pinchpass-linux-amd64\n` });
    await assert.rejects(
      () => verifyChecksum("pinchpass-linux-amd64", bytes, "https://example.test"),
      /checksum mismatch/,
    );

    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await verifyChecksum("pinchpass-linux-amd64", bytes, "https://example.test"), "missing");
  } finally {
    globalThis.fetch = original;
  }
});

test("findExisting skips a broken stub and finds a real binary", () => {
  const root = mkdtempSync(join(tmpdir(), "pinchpass-install-"));
  try {
    const stubDir = join(root, "stub");
    const realDir = join(root, "real");
    mkdirSync(stubDir, { recursive: true });
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(stubDir, "pinchpass"), Buffer.alloc(16));
    writeFileSync(join(realDir, "pinchpass"), Buffer.alloc(200 * 1024));
    if (process.platform !== "win32") chmodSync(join(realDir, "pinchpass"), 0o755);

    assert.equal(findExisting("pinchpass", [stubDir, realDir]), join(realDir, "pinchpass"));
    assert.equal(findExisting("pinchpass", [stubDir]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBinaryVersion parses output and tolerates old binaries", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "pinchpass-ver-"));
  try {
    const ok = join(root, "ok");
    writeFileSync(ok, '#!/bin/sh\necho "pinchpass v3.4.5 (abcdef0)"\n');
    chmodSync(ok, 0o755);
    assert.equal(readBinaryVersion(ok), "3.4.5");

    const old = join(root, "old");
    writeFileSync(old, "#!/bin/sh\nexit 1\n");
    chmodSync(old, 0o755);
    assert.equal(readBinaryVersion(old), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
