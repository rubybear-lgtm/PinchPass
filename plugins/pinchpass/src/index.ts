/**
 * PinchPass — one-time E2E-encrypted secret request links.
 *
 * Dual-mode extension:
 *  - Pi (pi.dev): registers a native `request_secret` tool. The tool spawns the
 *    pinchpass CLI, streams the one-time link to the user immediately, blocks
 *    until they submit (or TTL expires), and returns the result. Cancelable
 *    with Esc.
 *  - OpenClaw: registers the same `request_secret` tool via the OpenClaw
 *    plugin API (kept for backward compatibility).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Extra directories where the postinstall script may have placed the binary. */
const FALLBACK_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".openclaw", "bin"),
  join(homedir(), ".pi", "bin"),
];

function findBinary(): string | null {
  const name = process.platform === "win32" ? "pinchpass.exe" : "pinchpass";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = [...(process.env.PATH ?? "").split(sep).filter(Boolean), ...FALLBACK_DIRS];
  for (const dir of dirs) {
    try {
      const candidate = join(dir, name);
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

const BINARY_MISSING = `The pinchpass binary is not installed. Install it with one of:

  npm i -g @pinchpass/cli      # downloads the prebuilt binary for your platform
  go install github.com/rubybear-lgtm/pinchpass@latest

Then try request_secret again.`;

/** Pull complete JSON objects out of a (possibly pretty-printed) stream. */
function takeJsonBlobs(text: string): { blobs: unknown[]; rest: string } {
  const blobs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          blobs.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // skip malformed output
        }
        start = -1;
      }
    }
  }
  return { blobs, rest: start >= 0 ? text.slice(start) : "" };
}

interface RequestArgs {
  names: string[];
  tunnel?: boolean;
  note?: string;
  ttl?: number;
  out?: string;
  via?: "auto" | "modal" | "link";
}

/** Shell-escape a value for a double-quoted .env line (mirrors store.go). */
function escapeEnvValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

/** Write/update a single KEY="value" line in a .env file (mirrors store.go). */
function writeEnvKey(path: string, key: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${key}="${escapeEnvValue(value)}"`;
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // new file
  }
  const out: string[] = [];
  let replaced = false;
  for (const l of existing.split("\n")) {
    const t = l.trim();
    if (t === "") continue;
    if (t.startsWith(key + "=")) {
      out.push(line);
      replaced = true;
    } else {
      out.push(l);
    }
  }
  if (!replaced) out.push(line);
  writeFileSync(path, out.join("\n") + "\n", { mode: 0o600 });
}

/**
 * Collect secrets directly in the Pi UI via modal dialogs. The value goes
 * straight from the user's keyboard into the .env file — it is never sent to
 * the LLM, never enters the session transcript, and no server is started.
 */
async function collectViaModal(ctx: { cwd: string; ui: { input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined> } }, params: RequestArgs, signal?: AbortSignal) {
  const outPath = resolve(ctx.cwd, params.out ?? ".env");
  const saved: string[] = [];
  for (const name of params.names) {
    const value = await ctx.ui.input(`Enter ${name}`, params.note ?? `Secret value for ${name}`, {
      signal,
    });
    if (value === undefined) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Secret request cancelled — ${name} not provided.${saved.length ? ` (${saved.join(", ")} already saved)` : ""} No further secrets were collected.`,
          },
        ],
        details: { success: false, names: params.names, saved, aborted: true },
      };
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Secret request cancelled — ${name} was empty.${saved.length ? ` (${saved.join(", ")} already saved)` : ""}`,
          },
        ],
        details: { success: false, names: params.names, saved, aborted: true },
      };
    }
    writeEnvKey(outPath, name, trimmed);
    saved.push(name);
  }
  return {
    content: [
      { type: "text" as const, text: `✅ Secrets collected via Pi modal: ${saved.join(", ")}\nSaved to ${outPath}` },
    ],
    details: {
      success: true,
      names: saved,
      message: "Secrets collected via Pi modal.",
      url: undefined,
      aborted: false,
    },
  };
}

function buildArgs(params: RequestArgs): string[] {
  const args = ["request", ...params.names, "-json"];
  if (params.tunnel) args.push("-tunnel");
  if (params.note) args.push("-note", params.note);
  if (typeof params.ttl === "number") args.push("-ttl", String(params.ttl));
  if (params.out) args.push("-out", params.out);
  return args;
}

/* ------------------------------------------------------------------ */
/* Pi native tool                                                      */
/* ------------------------------------------------------------------ */

function registerPiTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "request_secret",
    label: "Request Secret",
    description:
      "Collect sensitive values (API keys, tokens, passwords, connection strings) from the user. " +
      "With via='modal' (default in the Pi TUI) a dialog collects each value directly into the .env file — the value never reaches the LLM. " +
      "With via='link' it starts a local pinchpass server and streams a one-time E2E-encrypted link to the user immediately, blocking until they submit or the TTL expires. " +
      "On success the secrets are saved to the .env file and this tool returns the result.",
    promptSnippet: "Collect secrets from the user through an encrypted one-time link or a Pi modal",
    promptGuidelines: [
      "Use request_secret when you need an API key, token, or password from the user — never ask them to paste secrets directly into chat.",
      "request_secret streams the link (or shows the modal) to the user immediately; wait for its result before continuing.",
      "Use request_secret with tunnel: true when the user is not on the same machine as this agent.",
      "Use request_secret with via: 'link' to force the encrypted browser link, or via: 'modal' to force the Pi dialog.",
    ],
    parameters: Type.Object({
      names: Type.Array(Type.String({ description: "Secret name(s) to collect, e.g. ['GEMINI_API_KEY']" }), {
        minItems: 1,
        description: "Secret name(s) to collect",
      }),
      tunnel: Type.Optional(
        Type.Boolean({ description: "Create a public URL via bore.pub tunnel (default: false)" }),
      ),
      note: Type.Optional(Type.String({ description: "Description shown on the form to help the user" })),
      ttl: Type.Optional(Type.Number({ description: "Minutes until the link expires (default: 30)" })),
      out: Type.Optional(Type.String({ description: "Output .env file path (default: .env in the working directory)" })),
      via: Type.Optional(
        StringEnum(["auto", "modal", "link"] as const, {
          description: "How to collect: 'modal' prompts in the Pi UI, 'link' generates the encrypted browser link, 'auto' picks modal in the TUI and link elsewhere (default: auto)",
        }),
      ),
    }),
    async execute(_toolCallId, params: RequestArgs, signal, onUpdate, ctx) {
      const via = params.via ?? "auto";
      const useModal = via === "modal" || (via === "auto" && ctx.mode === "tui");
      if (useModal) {
        if (!ctx.hasUI) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Modal collection is unavailable here (no interactive UI in this mode). Call request_secret again with via: 'link' to use the encrypted browser link.",
              },
            ],
            details: { success: false, names: params.names, error: "no-ui" },
          };
        }
        return collectViaModal(ctx, params, signal);
      }

      const binary = findBinary();
      if (!binary) {
        throw new Error(BINARY_MISSING);
      }

      const child = spawn(binary, buildArgs(params), {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      let stderr = "";
      const blobs: Array<{ success?: boolean; url?: string; names?: string[]; message?: string; port?: number }> = [];

      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const { blobs: found, rest } = takeJsonBlobs(buffer);
            buffer = rest;
            for (const blob of found) {
              blobs.push(blob as (typeof blobs)[number]);
              const b = blob as { url?: string; names?: string[]; message?: string; port?: number };
              if (b.url) {
                const ttlNote = b.message ? ` (${b.message})` : "";
                onUpdate?.({
                  content: [
                    {
                      type: "text" as const,
                      text: `🔗 One-time E2E-encrypted secret request link${ttlNote}:\n${b.url}\n\nAsk the user to open it and submit ${(b.names ?? []).join(", ") || "the secret"}.`,
                    },
                  ],
                  details: { url: b.url, port: b.port, names: b.names ?? [] },
                });
              }
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          child.on("error", (err) => reject(err));
          child.on("close", (code) => resolve(code));
        });

        if (signal?.aborted) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Secret request cancelled (${params.names.join(", ")}). No value was saved.`,
              },
            ],
            details: { success: false, names: params.names, aborted: true },
          };
        }

        const firstBlob = blobs[0];
        const lastBlob = blobs[blobs.length - 1];
        if (!lastBlob) {
          throw new Error(
            `pinchpass exited without JSON output (code ${exitCode}).${stderr ? `\n${stderr}` : ""}`,
          );
        }

        const success = lastBlob.success === true;
        const lines = success
          ? [`✅ Secrets collected: ${(lastBlob.names ?? params.names).join(", ")}`]
          : [`❌ ${lastBlob.message ?? "Secret request failed."}`];
        if (firstBlob?.url) lines.push(`Link: ${firstBlob.url}`);
        if (success) lines.push(`Saved to ${params.out ?? ".env"} in ${ctx.cwd}`);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            success,
            names: lastBlob.names ?? params.names,
            url: firstBlob?.url,
            message: lastBlob.message,
            port: lastBlob.port,
            aborted: false,
          },
        };
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* OpenClaw plugin (backward compatible)                               */
/* ------------------------------------------------------------------ */

async function registerOpenClawTool(api: { $?: unknown }) {
  const { tool } = await import("@opencode-ai/plugin/tool");
  return {
    tool: {
      request_secret: tool({
        description:
          "Generate a one-time E2E-encrypted secret request link. " +
          "Use when you need to collect sensitive values (API keys, tokens, passwords) from the user. " +
          "The tool starts a local server, prints a link, and blocks until the user submits or the TTL expires. " +
          "On success the secret is saved to .env and the tool returns the result.",
        args: {
          names: tool.schema
            .array(tool.schema.string())
            .min(1)
            .describe("Secret name(s) to collect, e.g. ['GEMINI_API_KEY']"),
          tunnel: tool.schema
            .boolean()
            .optional()
            .describe("Create a public URL via bore.pub tunnel (default: false)"),
          note: tool.schema.string().optional().describe("Description shown on the form to help the user"),
          ttl: tool.schema.number().optional().describe("Minutes until the link expires (default: 30)"),
        },
        async execute(args: RequestArgs) {
          const binary = findBinary() ?? "pinchpass";
          const pieces = [binary, "request", ...args.names, "-json"];
          if (args.tunnel) pieces.push("-tunnel");
          if (args.note) pieces.push("-note", args.note);
          if (args.ttl) pieces.push("-ttl", String(args.ttl));
          try {
            const result = await (api.$ as { raw: (p: string[]) => Promise<unknown> }).raw(pieces);
            return (result as { stdout?: string; text?: string })?.stdout ||
              (result as { text?: string })?.text ||
              String(result);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const stderr =
              err && typeof err === "object" && "stderr" in err ? (err as { stderr?: string }).stderr : "";
            return `Failed: ${msg}${stderr ? "\n" + stderr : ""}`;
          }
        },
      }),
    },
  };
}

export default async function (api: unknown) {
  const pi = api as Partial<ExtensionAPI>;
  if (pi && typeof pi.registerTool === "function") {
    registerPiTool(pi as ExtensionAPI);
    return;
  }
  // OpenClaw plugin contract: default export receives `{ $ }` and returns `{ tool }`.
  return registerOpenClawTool((api ?? {}) as { $?: unknown });
}
