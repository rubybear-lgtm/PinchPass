#!/usr/bin/env node
/**
 * Install or update the pinchpass binary for the current platform.
 *
 * npm runs this as a `postinstall`, so it must be idempotent and it must make
 * `npm update -g @pinchpass/cli` actually upgrade the binary:
 *
 *   1. Look for an existing `pinchpass` (PATH, then the known install dirs).
 *   2. If one already reports the package's version, do nothing.
 *   3. Otherwise download the release asset pinned to the package version,
 *      verify it against the release's checksums.txt, and install it to
 *      ~/.local/bin.
 *
 * Set PINCHPASS_SKIP_DOWNLOAD=1 to skip the download entirely (used by CI).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "rubybear-lgtm/PinchPass";

/** Real binaries are multi-MB; a failed download leaves a tiny stub behind. */
const MIN_VALID_BYTES = 100 * 1024;

const here = dirname(fileURLToPath(import.meta.url));

export function packageVersion() {
  return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
}

export function binaryName(platform = process.platform) {
  return platform === "win32" ? "pinchpass.exe" : "pinchpass";
}

export function assetName(platform = process.platform, arch = process.arch) {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[platform];
  if (!os) throw new Error(`Unsupported platform: ${platform}`);
  return `pinchpass-${os}-${arch === "arm64" ? "arm64" : "amd64"}`;
}

/** Extract an x.y.z version from `pinchpass --version` output. */
export function parseVersion(text) {
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+)(?=\s|$)/.exec(text ?? "");
  return match ? match[1] : null;
}

/** Numeric x.y.z comparison. Returns -1, 0, or 1. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Find the SHA-256 for `asset` in a checksums.txt body. */
export function checksumFor(text, asset) {
  for (const line of (text ?? "").split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

export function knownDirs(home = homedir()) {
  return [join(home, ".local", "bin"), join(home, ".openclaw", "bin"), join(home, ".pi", "bin")];
}

function searchDirs() {
  const sep = process.platform === "win32" ? ";" : ":";
  return [...(process.env.PATH ?? "").split(sep).filter(Boolean), ...knownDirs()];
}

function isValidBinary(path) {
  try {
    return statSync(path).size >= MIN_VALID_BYTES;
  } catch {
    return false;
  }
}

/** Read the version a binary reports; null for pre-1.2.0 builds (no --version). */
export function readBinaryVersion(bin) {
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return parseVersion(out);
  } catch {
    return null;
  }
}

export function findExisting(name, dirs = searchDirs()) {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && isValidBinary(candidate)) return candidate;
  }
  return null;
}

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** Download the asset for `version`, falling back to `latest` if it is missing. */
export async function downloadAsset(asset, version) {
  const versioned = `https://github.com/${REPO}/releases/download/v${version}/${asset}`;
  const first = await fetchBytes(versioned);
  if (first.ok) {
    return { bytes: first.bytes, base: versioned.slice(0, -asset.length - 1) };
  }

  const latest = `https://github.com/${REPO}/releases/latest/download/${asset}`;
  const second = await fetchBytes(latest);
  if (second.ok) {
    return { bytes: second.bytes, base: latest.slice(0, -asset.length - 1), fallback: true };
  }
  throw new Error(`could not download ${asset} (v${version}: ${first.status}, latest: ${second.status})`);
}

/** Returns "verified", "missing", or throws on a checksum mismatch. */
export async function verifyChecksum(asset, bytes, base) {
  const res = await fetch(`${base}/checksums.txt`, { redirect: "follow" });
  if (!res.ok) return "missing";
  const expected = checksumFor(await res.text(), asset);
  if (!expected) return "missing";
  if (expected !== sha256(bytes)) throw new Error(`checksum mismatch for ${asset}`);
  return "verified";
}

function writeExecutable(target, bytes) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

export async function install({ log = console.log, warn = console.warn } = {}) {
  if (process.env.PINCHPASS_SKIP_DOWNLOAD) {
    log("pinchpass: PINCHPASS_SKIP_DOWNLOAD set; skipping binary download");
    return { installed: false, reason: "skipped" };
  }

  const version = packageVersion();
  const name = binaryName();
  const existing = findExisting(name);
  const existingVersion = existing ? readBinaryVersion(existing) : null;

  if (existing && existingVersion === version) {
    log(`pinchpass ${version} already installed at ${existing}`);
    return { installed: false, reason: "up-to-date", path: existing };
  }

  const asset = assetName();
  const { bytes, base, fallback } = await downloadAsset(asset, version);
  if (fallback) {
    warn(`pinchpass: no release asset for v${version}; installed the latest release instead`);
  }

  const checksum = await verifyChecksum(asset, bytes, base);
  if (checksum !== "verified") {
    warn(`pinchpass: checksums.txt unavailable for ${asset}; installed without verification`);
  }

  const target = join(homedir(), ".local", "bin", name);
  writeExecutable(target, bytes);

  const from = existingVersion ? `v${existingVersion}` : "no previous binary";
  log(`pinchpass: ${from} -> ${fallback ? "the latest release" : `v${version}`} at ${target}`);

  if (existing && existing !== target && !knownDirs().some((dir) => existing.startsWith(dir))) {
    warn(`pinchpass: ${existing} shadows the new binary on PATH — remove or update it`);
  }
  return { installed: true, version, path: target, checksum };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  install().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    // Never fail the npm install: an existing binary or `go install` still works.
    console.warn(`pinchpass: could not install the binary — ${message}`);
    console.warn(
      "pinchpass: install it later with `go install github.com/rubybear-lgtm/pinchpass@latest` or `npm i -g @pinchpass/cli`",
    );
  });
}
