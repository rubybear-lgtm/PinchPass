/** Locate the pinchpass binary without requiring PATH configuration. */
import { accessSync, constants, statSync } from "node:fs";
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
