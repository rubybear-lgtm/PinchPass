/** Locate the pinchpass binary without requiring PATH configuration. */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
/** Real binaries are multi-MB; a failed download can leave a tiny stub behind. */
export const MIN_VALID_BYTES = 100 * 1024;
/** Extra directories where the postinstall script may have placed the binary. */
export const FALLBACK_DIRS = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".openclaw", "bin"),
    join(homedir(), ".pi", "bin"),
];
export const BINARY_MISSING = `The pinchpass binary is not installed. Install it with one of:

  npm i -g @pinchpass/cli      # downloads the prebuilt binary for your platform
  go install github.com/rubybear-lgtm/pinchpass@latest

Then try request_secret again.`;
export function binaryName(platform = process.platform) {
    return platform === "win32" ? "pinchpass.exe" : "pinchpass";
}
/**
 * Search explicit directories for an executable `pinchpass`.
 *
 * A candidate that looks like a real binary (>= MIN_VALID_BYTES) wins over one
 * that does not, so a stale stub earlier in PATH cannot shadow a good install.
 */
export function findBinaryIn(dirs, platform = process.platform) {
    const name = binaryName(platform);
    const seen = new Set();
    const executable = [];
    for (const dir of dirs) {
        if (!dir || seen.has(dir))
            continue;
        seen.add(dir);
        const candidate = join(dir, name);
        try {
            accessSync(candidate, constants.X_OK);
        }
        catch {
            continue;
        }
        executable.push(candidate);
    }
    for (const candidate of executable) {
        try {
            if (statSync(candidate).size >= MIN_VALID_BYTES)
                return candidate;
        }
        catch {
            // keep looking
        }
    }
    return executable[0] ?? null;
}
/** Find pinchpass on PATH, then in the known install directories. */
export function findBinary() {
    const sep = process.platform === "win32" ? ";" : ":";
    const pathDirs = (process.env.PATH ?? "").split(sep).filter(Boolean);
    return findBinaryIn([...pathDirs, ...FALLBACK_DIRS]);
}
const PACKAGE_NAME = "@pinchpass/cli";
const UPDATE_HINT = `npm i -g ${PACKAGE_NAME} (or go install github.com/rubybear-lgtm/pinchpass@latest)`;
/** The version of this npm package, read from its own package.json. */
export function packageVersion() {
    try {
        const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
        return JSON.parse(raw).version ?? null;
    }
    catch {
        return null;
    }
}
/** Extract x.y.z from `pinchpass --version` output (null for older builds). */
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
        if (diff !== 0)
            return diff < 0 ? -1 : 1;
    }
    return 0;
}
const versionCache = new Map();
/** The version a binary reports, or null when it predates --version. */
export function binaryVersion(bin) {
    if (versionCache.has(bin))
        return versionCache.get(bin) ?? null;
    let result = null;
    try {
        const out = execFileSync(bin, ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
        });
        result = parseVersion(out);
    }
    catch {
        result = null;
    }
    versionCache.set(bin, result);
    return result;
}
/** A one-line update hint when the resolved binary is older than the package. */
export function updateNotice(bin) {
    const pkg = packageVersion();
    if (!pkg)
        return null;
    const installed = binaryVersion(bin);
    if (!installed) {
        return `this pinchpass binary predates version reporting — update it: ${UPDATE_HINT}`;
    }
    if (compareVersions(installed, pkg) < 0) {
        return `pinchpass v${installed} is older than this package (v${pkg}) — update it: ${UPDATE_HINT}`;
    }
    return null;
}
