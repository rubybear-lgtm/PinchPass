import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escapeEnvValue, renderEnv, writeEnvKey } from "../dist/env.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "pinchpass-env-"));
}

test("escapeEnvValue escapes shell metacharacters", () => {
  assert.equal(escapeEnvValue(String.raw`a\b`), String.raw`a\\b`);
  assert.equal(escapeEnvValue('a"b'), String.raw`a\"b`);
  assert.equal(escapeEnvValue("a$b"), String.raw`a\$b`);
  assert.equal(escapeEnvValue("a`b"), "a\\`b");
  assert.equal(escapeEnvValue("plain"), "plain");
});

test("renderEnv appends a new key and keeps existing lines", () => {
  const out = renderEnv("A=1\n\nB=2\n", "C", "3");
  assert.equal(out, 'A=1\nB=2\nC="3"\n');
});

test("renderEnv replaces an existing key in place, preserving order", () => {
  const out = renderEnv("A=1\nB=old\nC=3\n", "B", "new");
  assert.equal(out, 'A=1\nB="new"\nC=3\n');
});

test("writeEnvKey writes a quoted line with a trailing newline and 0600", () => {
  const dir = tmp();
  try {
    const file = join(dir, ".env");
    writeEnvKey(file, "API_KEY", "s3cret");
    assert.equal(readFileSync(file, "utf8"), 'API_KEY="s3cret"\n');
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeEnvKey creates parent directories and leaves no temp files behind", () => {
  const dir = tmp();
  try {
    const file = join(dir, "nested", "deeper", ".env");
    writeEnvKey(file, "A", "1");
    writeEnvKey(file, "B", "2");
    assert.equal(readFileSync(file, "utf8"), 'A="1"\nB="2"\n');
    assert.deepEqual(readdirSync(join(dir, "nested", "deeper")), [".env"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeEnvKey round-trips values that need escaping", () => {
  const dir = tmp();
  try {
    const file = join(dir, ".env");
    const raw = 'pa$$w"o\\rd`x';
    writeEnvKey(file, "TOKEN", raw);
    const line = readFileSync(file, "utf8").trim();
    assert.equal(line, 'TOKEN="pa\\$\\$w\\"o\\\\rd\\`x"');
    const parsed = line.slice("TOKEN=".length + 1, -1).replace(/\\(.)/g, "$1");
    assert.equal(parsed, raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeEnvKey overwrites existing content atomically", () => {
  const dir = tmp();
  try {
    const file = join(dir, ".env");
    writeFileSync(file, "KEEP=yes\nTOKEN=old\n");
    writeEnvKey(file, "TOKEN", "new");
    assert.equal(readFileSync(file, "utf8"), 'KEEP=yes\nTOKEN="new"\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
