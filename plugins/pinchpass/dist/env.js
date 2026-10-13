/**
 * `.env` writing helpers for the modal collection path.
 *
 * Mirrors `store.EnvStore.Save` in the Go CLI: values are written as
 * `KEY="value"` with shell-safe escaping, and an existing key is replaced in
 * place. Writes go through a temp file + rename so a crash or a concurrent
 * reader never observes a half-written file.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
/** Shell-escape a value for a double-quoted .env line (mirrors store.go). */
export function escapeEnvValue(s) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}
/** Render the file contents with `key` set to `value`, replacing any existing line. */
export function renderEnv(existing, key, value) {
    const line = `${key}="${escapeEnvValue(value)}"`;
    const out = [];
    let replaced = false;
    for (const l of existing.split("\n")) {
        const t = l.trim();
        if (t === "")
            continue;
        if (t.startsWith(key + "=")) {
            out.push(line);
            replaced = true;
        }
        else {
            out.push(l);
        }
    }
    if (!replaced)
        out.push(line);
    return out.join("\n") + "\n";
}
/** Write/update a single KEY="value" line in a .env file. */
export function writeEnvKey(path, key, value) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let existing = "";
    try {
        existing = readFileSync(path, "utf8");
    }
    catch {
        // new file
    }
    const tmp = join(dir, `.pinchpass-${randomBytes(6).toString("hex")}.tmp`);
    try {
        writeFileSync(tmp, renderEnv(existing, key, value), { mode: 0o600 });
        renameSync(tmp, path);
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch {
            // nothing to clean up
        }
        throw err;
    }
}
