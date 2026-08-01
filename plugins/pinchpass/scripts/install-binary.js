#!/usr/bin/env node
/**
 * Downloads the prebuilt pinchpass binary for the current platform.
 *
 * Install locations (first hit wins):
 *   1. If `pinchpass` is already on PATH, nothing to do.
 *   2. If it already exists in a known install dir, nothing to do.
 *   3. Install to ~/.local/bin (universal user bin — the PinchPass Pi
 *      extension and OpenClaw plugin both find it there without PATH changes).
 *
 * The Pi extension resolves the binary from PATH, then from
 * ~/.local/bin, ~/.openclaw/bin, and ~/.pi/bin — so PATH is never required.
 */
import { execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const VERSION = "latest";
const REPO = "rubybear-lgtm/PinchPass";

/** Real pinchpass binaries are multi-MB; "installed" stubs are tiny (e.g. a failed curl). */
const MIN_VALID_BYTES = 100 * 1024;

function isValidBinary(path) {
  try {
    return statSync(path).size >= MIN_VALID_BYTES;
  } catch {
    return false;
  }
}

function detectBinary() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const osMap = { darwin: "darwin", linux: "linux", win32: "windows" };
  const plat = osMap[process.platform];
  if (!plat) throw new Error(`Unsupported platform: ${process.platform}`);
  return { name: `pinchpass-${plat}-${arch}`, plat, arch };
}

function onPath(name) {
  try {
    const found = execSync(
      process.platform === "win32" ? `where ${name}` : `which ${name}`,
      { stdio: ["ignore", "pipe", "ignore"], shell: true },
    )
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    return found || null;
  } catch {
    return null;
  }
}

async function install() {
  const { name } = detectBinary();
  const exe = process.platform === "win32" ? ".exe" : "";
  const knownDirs = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".openclaw", "bin"),
    join(homedir(), ".pi", "bin"),
  ];

  // 1. Already on PATH?
  const onPathLocation = onPath(`pinchpass${exe}`);
  if (onPathLocation && isValidBinary(onPathLocation)) {
    console.log(`pinchpass already available on PATH at ${onPathLocation}`);
    return;
  }

  // 2. Already installed in a known dir? (skip broken stubs from failed downloads)
  for (const dir of knownDirs) {
    const candidate = join(dir, `pinchpass${exe}`);
    if (existsSync(candidate) && isValidBinary(candidate)) {
      console.log(`pinchpass already installed at ${candidate}`);
      return;
    }
  }

  // 3. Install to ~/.local/bin (universal user bin).
  const installDir = join(homedir(), ".local", "bin");
  const dest = join(installDir, `pinchpass${exe}`);
  const url =
    VERSION === "latest"
      ? `https://github.com/${REPO}/releases/latest/download/${name}`
      : `https://github.com/${REPO}/releases/download/v${VERSION}/${name}`;

  console.log(`Downloading pinchpass from ${url}...`);

  mkdirSync(installDir, { recursive: true });
  execSync(`curl -sL "${url}" -o "${dest}"`, { stdio: "inherit" });
  if (process.platform !== "win32") chmodSync(dest, 0o755);

  console.log(`Installed pinchpass to ${dest}`);
  const onPathNow = onPath(`pinchpass${exe}`);
  if (!onPathNow) {
    console.log(`Add ${installDir} to your PATH if you want to use the CLI directly.`);
    console.log("(The PinchPass Pi extension and OpenClaw plugin find the binary without PATH changes.)");
  }
}

install().catch((err) => {
  console.error(`Failed to install pinchpass binary: ${err.message}`);
  console.log(`To build from source: cd pinchpass && go build -o pinchpass .`);
  process.exit(1);
});
