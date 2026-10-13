/**
 * Incremental parser for the CLI's `-json` output.
 *
 * The CLI prints two pretty-printed JSON objects (before and after waiting),
 * so a byte stream can split them across chunks. `takeJsonBlobs` returns every
 * complete top-level object and leaves any partial trailing object in `rest`.
 */
export function takeJsonBlobs(text) {
    const blobs = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (c === "\\")
                escaped = true;
            else if (c === '"')
                inString = false;
            continue;
        }
        if (c === '"') {
            inString = true;
            continue;
        }
        if (c === "{") {
            if (depth === 0)
                start = i;
            depth++;
        }
        else if (c === "}") {
            depth = Math.max(0, depth - 1);
            if (depth === 0 && start >= 0) {
                try {
                    blobs.push(JSON.parse(text.slice(start, i + 1)));
                }
                catch {
                    // skip malformed output
                }
                start = -1;
            }
        }
    }
    return { blobs, rest: start >= 0 ? text.slice(start) : "" };
}
