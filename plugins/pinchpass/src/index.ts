/**
 * PinchPass — one-time E2E-encrypted secret request links.
 *
 * Dual-mode extension:
 *  - Pi (pi.dev): registers a native `request_secret` tool. In the interactive
 *    TUI a masked dialog collects each value straight into the .env file (it
 *    never reaches the LLM). Outside the TUI, or with `tunnel: true` /
 *    `via: "link"`, the tool spawns the pinchpass CLI, streams the one-time
 *    link to the user immediately, blocks until they submit (or the TTL
 *    expires), and returns the result. Cancelable with Esc.
 *  - OpenClaw: registers the same `request_secret` tool via the OpenClaw
 *    plugin API (kept for backward compatibility).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum, type JsonValue } from "@earendil-works/pi-ai";
import {
  CURSOR_MARKER,
  Key,
  Text,
  matchesKey,
  renderFakeCursor,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { buildArgs, chooseVia, type CollectionVia, type RequestArgs } from "./args.js";
import { BINARY_MISSING, findBinary, updateNotice } from "./binary.js";
import { writeEnvKey } from "./env.js";
import { takeJsonBlobs } from "./json-stream.js";

/** Small figlet "small" font rendering of PINCHPASS. */
const PINCHPASS_ART =
  "  ___ ___ _  _  ___ _  _ ___  _   ___ ___ \n" +
  " | _ \\_ _| \\| |/ __| || | _ \\/_\\ / __/ __|\n" +
  " |  _/| || .` | (__| __ |  _/ _ \\\\__ \\__ \\\n" +
  " |_| |___|_|\\_|\\___|_||_|_|/_/ \\_\\___/___/";

interface SecretRequestDetails {
  success: boolean;
  aborted: boolean;
  via: CollectionVia;
  names: string[];
  /** Names written to disk (modal) or provisioned by the CLI (link). */
  saved: string[];
  out?: string;
  url?: string;
  port?: number;
  message?: string;
  error?: string;
}

const RESULT_SCHEMA = Type.Object({
  success: Type.Boolean(),
  aborted: Type.Boolean(),
  via: StringEnum(["modal", "link"] as const),
  names: Type.Array(Type.String()),
  saved: Type.Array(Type.String()),
  out: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  port: Type.Optional(Type.Number()),
  message: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});

interface SecretRequestResult {
  content: Array<{ type: "text"; text: string }>;
  details: SecretRequestDetails;
  structuredContent: JsonValue;
  isError: boolean;
}

function makeResult(details: SecretRequestDetails, text: string, isError = false): SecretRequestResult {
  return {
    content: [{ type: "text", text }],
    details,
    structuredContent: { ...details } as unknown as JsonValue,
    isError,
  };
}

/* ------------------------------------------------------------------ */
/* Serialized file writes                                              */
/* ------------------------------------------------------------------ */

type FileQueue = <T>(filePath: string, fn: () => Promise<T>) => Promise<T>;

const localFileQueues = new Map<string, Promise<unknown>>();

/** Fallback used when the host does not expose `withFileMutationQueue`. */
function localFileQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const previous = localFileQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  localFileQueues.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

const withFileQueue: FileQueue =
  typeof (piCodingAgent as { withFileMutationQueue?: unknown }).withFileMutationQueue === "function"
    ? (piCodingAgent as unknown as { withFileMutationQueue: FileQueue }).withFileMutationQueue
    : localFileQueue;

/**
 * Branded masked secret dialog (Pi TUI overlay). The value is rendered as
 * bullets, never echoed, and submitted straight to the caller. Handles
 * bracketed paste and terminal escape sequences explicitly.
 */
async function promptSecretTUI(
  ctx: ExtensionContext,
  name: string,
  note: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, kb, done) => {
      let value = "";
      let alive = true;
      let pasteBuffer = "";
      let isInPaste = false;
      let cachedLines: string[] | undefined;
      let cachedWidth = 0;
      let cachedValueLength = -1;

      const finish = (v: string | undefined) => {
        if (!alive) return;
        alive = false;
        if (signal) signal.removeEventListener("abort", onAbort);
        done(v);
      };
      const onAbort = () => finish(undefined);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const refresh = () => {
        cachedLines = undefined;
        tui.requestRender(true);
      };

      const comp: Component & Focusable = {
        focused: true,
        handleInput(data: string) {
          if (!alive) return;

          // Bracketed paste: accumulate until the end marker, then insert.
          if (data.includes("\u001b[200~")) {
            isInPaste = true;
            pasteBuffer = "";
            data = data.replace("\u001b[200~", "");
          }
          if (isInPaste) {
            pasteBuffer += data;
            const end = pasteBuffer.indexOf("\u001b[201~");
            if (end === -1) {
              refresh();
              return;
            }
            const pasted = pasteBuffer.slice(0, end);
            const remaining = pasteBuffer.slice(end + 6);
            pasteBuffer = "";
            isInPaste = false;
            for (const ch of pasted) {
              if (ch >= " " && ch !== "\u007f") value += ch;
            }
            if (remaining) comp.handleInput?.(remaining);
            else refresh();
            return;
          }

          if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
            finish(undefined);
            return;
          }
          if (kb.matches(data, "tui.input.submit") || matchesKey(data, Key.enter) || data === "\n") {
            finish(value);
            return;
          }
          if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
            value = value.slice(0, -1);
            refresh();
            return;
          }
          // Ignore unhandled escape sequences (arrows, home/end, …) as a chunk.
          if (data.startsWith("\u001b")) {
            refresh();
            return;
          }
          for (const ch of data) {
            if (ch >= " " && ch !== "\u007f") value += ch;
          }
          refresh();
        },
        invalidate() {
          cachedLines = undefined;
        },
        render(width: number) {
          if (cachedLines && cachedWidth === width && cachedValueLength === value.length) return cachedLines;

          const renderWidth = Math.max(1, width);
          const art = PINCHPASS_ART.split("\n");
          const artWidth = art.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
          const boxWidth = Math.min(Math.max(artWidth + 4, 40), Math.max(20, renderWidth - 2));
          const innerWidth = Math.max(4, boxWidth - 4);
          const leftPad = " ".repeat(Math.max(0, Math.floor((renderWidth - boxWidth) / 2)));
          const border = (s: string) => theme.fg("borderAccent", s);

          const boxed = (content: string) => {
            const clipped = truncateToWidth(content, innerWidth, "");
            const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
            return `${leftPad}${border("│")} ${clipped}${fill} ${border("│")}`;
          };
          const centered = (raw: string) => {
            const w = visibleWidth(raw);
            if (w >= innerWidth) return raw;
            const left = Math.floor((innerWidth - w) / 2);
            return " ".repeat(left) + raw + " ".repeat(innerWidth - w - left);
          };

          const lines: string[] = [];
          lines.push("");
          lines.push(`${leftPad}${border(`╭${"─".repeat(Math.max(0, boxWidth - 2))}╮`)}`);
          for (const a of art) lines.push(boxed(centered(theme.fg("muted", a))));
          lines.push(boxed(""));
          lines.push(boxed(theme.fg("toolTitle", theme.bold(`  🔐  ${name}`))));
          if (note) lines.push(boxed(theme.fg("dim", `      ${note}`)));
          lines.push(boxed(""));

          const maxDots = Math.max(1, innerWidth - 3);
          const dots = "•".repeat(Math.min(value.length, maxDots));
          const cursor = `${CURSOR_MARKER}${renderFakeCursor(theme.fg("accent", " "))}`;
          lines.push(boxed(`  ${theme.fg("accent", dots)}${cursor}`));

          lines.push(`${leftPad}${border(`╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`)}`);
          lines.push(boxed(`${theme.fg("dim", "enter submit")}${theme.fg("muted", "    esc cancel")}`));
          lines.push("");

          cachedLines = lines;
          cachedWidth = width;
          cachedValueLength = value.length;
          return lines;
        },
      };
      return comp;
    },
    {
      overlay: true,
      overlayOptions: { width: "60%", minWidth: 54, maxHeight: "65%" },
    },
  );
}

/** Open a URL in the user's browser (best effort; loopback links only). */
function openInBrowser(url: string): void {
  if (process.platform === "darwin") {
    const p = spawn("open", [url], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } else if (process.platform === "win32") {
    const p = spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } else {
    const p = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  }
}

/** Auto-open a link only when it is reachable from this machine. */
function maybeOpenBrowser(url: string, mode: string): void {
  if (mode !== "tui") return;
  if (process.env.PINCHPASS_NO_OPEN) return;
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):/.test(url)) return;
  try {
    openInBrowser(url);
  } catch {
    // best effort — the link is still rendered in the TUI
  }
}

/**
 * Collect secrets directly in the Pi TUI via masked modal dialogs. Each value
 * goes straight from the user's keyboard into the .env file — it is never sent
 * to the LLM, never enters the session transcript, and no server is started.
 */
async function collectViaModal(
  ctx: ExtensionContext,
  params: RequestArgs,
  signal?: AbortSignal,
): Promise<SecretRequestResult> {
  const outPath = resolve(ctx.cwd, params.out ?? ".env");
  const ignored: string[] = [];
  if (typeof params.ttl === "number") ignored.push("ttl (link mode only)");
  const ignoreNote = ignored.length ? ` (ignored in modal mode: ${ignored.join(", ")})` : "";
  const saved: string[] = [];

  for (const name of params.names) {
    const value = await promptSecretTUI(ctx, name, params.note ?? "", signal);
    if (value === undefined) {
      return makeResult(
        { success: false, aborted: true, via: "modal", names: params.names, saved, out: outPath, error: "cancelled" },
        `Secret request cancelled — ${name} not provided.${saved.length ? ` (${saved.join(", ")} already saved)` : ""} No further secrets were collected.`,
      );
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return makeResult(
        { success: false, aborted: true, via: "modal", names: params.names, saved, out: outPath, error: "empty" },
        `Secret request cancelled — ${name} was empty.${saved.length ? ` (${saved.join(", ")} already saved)` : ""}`,
      );
    }
    await withFileQueue(outPath, async () => writeEnvKey(outPath, name, trimmed));
    saved.push(name);
  }

  return makeResult(
    { success: true, aborted: false, via: "modal", names: params.names, saved, out: outPath },
    `✅ Secrets collected via Pi modal: ${saved.join(", ")}\nSaved to ${outPath}${ignoreNote}`,
  );
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
      "Use request_secret with tunnel: true when the user is not on the same machine as this agent — tunnel always uses the encrypted browser link, never the modal.",
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
          description:
            "How to collect: 'modal' prompts in the Pi UI, 'link' generates the encrypted browser link, 'auto' picks modal in the TUI and link elsewhere (default: auto)",
        }),
      ),
    }),
    outputSchema: RESULT_SCHEMA,
    executionMode: "sequential",

    async execute(_toolCallId, params: RequestArgs, signal, onUpdate, ctx) {
      const { via, downgraded } = chooseVia(params.via, params.tunnel, ctx.mode);
      const useModal = via === "modal";

      if (useModal && !ctx.hasUI) {
        return makeResult(
          {
            success: false,
            aborted: false,
            via: "modal",
            names: params.names,
            saved: [],
            error: "no-ui",
          },
          "Modal collection is unavailable here (no interactive UI in this mode). Call request_secret again with via: 'link' to use the encrypted browser link.",
          true,
        );
      }
      if (useModal) {
        return collectViaModal(ctx, params, signal);
      }

      const downgradeNote = downgraded
        ? " (modal needs the interactive TUI; used the encrypted browser link instead)"
        : "";

      const binary = findBinary();
      if (!binary) {
        return makeResult(
          {
            success: false,
            aborted: false,
            via: "link",
            names: params.names,
            saved: [],
            error: "binary-missing",
            message: "pinchpass binary not found",
          },
          BINARY_MISSING,
          true,
        );
      }

      const child = spawn(binary, buildArgs(params), {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const notice = updateNotice(binary);

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
                  details: { url: b.url, port: b.port, names: b.names ?? [], via: "link" },
                });
                if (ctx.mode === "tui") {
                  const widget = [
                    `🔗 pinchpass — open this link to submit ${(b.names ?? []).join(", ") || "the secret"}:`,
                    b.url,
                  ];
                  if (notice) widget.push(`⚠ ${notice}`);
                  ctx.ui.setWidget("pinchpass-link", widget);
                }
                maybeOpenBrowser(b.url, ctx.mode);              }
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          child.on("error", (err) => reject(err));
          child.on("close", (code) => resolve(code));
        });

        const out = resolve(ctx.cwd, params.out ?? ".env");
        const firstBlob = blobs[0];
        const lastBlob = blobs[blobs.length - 1];
        // The CLI prints blob 1 before waiting and blob 2 after. A hard failure
        // (decrypt/save error) exits non-zero with only blob 1, so a single
        // blob is never a completed request.
        const completed = exitCode === 0 && blobs.length > 1 && lastBlob?.success === true;

        if (signal?.aborted) {
          if (completed) {
            const names = lastBlob.names ?? params.names;
            return makeResult(
              {
                success: true,
                aborted: false,
                via: "link",
                names,
                saved: names,
                out,
                url: firstBlob?.url,
                message: lastBlob.message,
                port: lastBlob.port,
              },
              `✅ Secrets collected: ${names.join(", ")}\nSaved to ${params.out ?? ".env"} in ${ctx.cwd}`,
            );
          }
          return makeResult(
            {
              success: false,
              aborted: true,
              via: "link",
              names: params.names,
              saved: [],
              error: "cancelled",
            },
            `Secret request cancelled (${params.names.join(", ")}). No value was saved.`,
          );
        }

        if (!lastBlob) {
          return makeResult(
            {
              success: false,
              aborted: false,
              via: "link",
              names: params.names,
              saved: [],
              error: "no-output",
              message: `pinchpass exited without JSON output (code ${exitCode})`,
            },
            `pinchpass exited without JSON output (code ${exitCode}).${stderr ? `\n${stderr}` : ""}`,
            true,
          );
        }

        const names = lastBlob.names ?? params.names;
        const failureMessage =
          exitCode !== 0
            ? stderr.trim() || `pinchpass exited with code ${exitCode}`
            : lastBlob.message ?? "Secret request failed.";
        const lines = completed
          ? [`✅ Secrets collected: ${names.join(", ")}`]
          : [`❌ ${failureMessage}`];
        if (firstBlob?.url) lines.push(`Link: ${firstBlob.url}`);
        if (completed) lines.push(`Saved to ${params.out ?? ".env"} in ${ctx.cwd}`);
        if (downgradeNote) lines.push(downgradeNote.trim());
        if (notice) lines.push(`⚠ ${notice}`);

        return makeResult(
          {
            success: completed,
            aborted: false,
            via: "link",
            names,
            saved: completed ? names : [],
            url: firstBlob?.url,
            message: completed ? lastBlob.message : failureMessage,
            port: lastBlob.port,
            out,
            error: completed ? undefined : exitCode !== 0 ? "cli-failed" : "not-provisioned",
          },
          lines.join("\n"),
          !completed,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return makeResult(
          {
            success: false,
            aborted: false,
            via: "link",
            names: params.names,
            saved: [],
            error: "spawn-failed",
            message,
          },
          `Failed to start pinchpass: ${message}${stderr ? `\n${stderr}` : ""}`,
          true,
        );
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (ctx.mode === "tui") ctx.ui.setWidget("pinchpass-link", undefined);
      }
    },

    /* Pretty TUI rendering: call line, result card (default tool shell). */
    renderCall(args: RequestArgs, theme) {
      const names = (args.names ?? []).join(", ");
      const via = args.via ?? "auto";
      let text =
        theme.fg("accent", "🔐 ") +
        theme.fg("toolTitle", theme.bold("pinchpass")) +
        theme.fg("dim", " · ") +
        theme.fg("accent", names);
      if (args.tunnel) text += theme.fg("dim", " · tunnel");
      text += theme.fg("muted", ` · ${via}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, options, theme) {
      const details = (result.details ?? {}) as Partial<SecretRequestDetails>;
      if (options.isPartial) {
        if (details.url) {
          const pending = (details.names ?? []).join(", ");
          let text = theme.fg("accent", "🔗 Open this one-time link in your browser");
          if (pending) text += theme.fg("dim", ` — submit ${pending}`);
          text += `\n${theme.fg("toolTitle", theme.bold(details.url))}`;
          text += `\n${theme.fg("warning", "⏳ Waiting for submission…")}${theme.fg("muted", "   esc to cancel")}`;
          return new Text(text, 0, 0);
        }
        return new Text(theme.fg("warning", "⏳ Starting pinchpass…"), 0, 0);
      }
      const success = details.success === true;
      const aborted = details.aborted === true;
      const names = (details.names ?? []).join(", ");
      const statusColor = success ? "success" : aborted ? "warning" : "error";
      const head = success
        ? "✅  Secrets collected"
        : aborted
          ? "✋  Cancelled"
          : `❌  ${details.message ?? "Failed"}`;
      let text = theme.fg("toolTitle", theme.bold(head));
      if (names) text += `\n${theme.fg(statusColor, `     ${names}`)}`;
      if (options.expanded) {
        if (details.via) text += `\n${theme.fg("dim", `     via: ${details.via}`)}`;
        if (details.url) text += `\n${theme.fg("dim", `     Link: ${details.url}`)}`;
        if (details.out) text += `\n${theme.fg("dim", `     Saved to: ${details.out}`)}`;
        if (details.message) text += `\n${theme.fg("muted", `     ${details.message}`)}`;
        text += "\n";
        for (const line of PINCHPASS_ART.split("\n")) {
          text += `\n${theme.fg("muted", `     ${line}`)}`;
        }
      }
      return new Text(text, 0, 0);
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
          out: tool.schema.string().optional().describe("Output .env file path (default: .env)"),
        },
        async execute(args: RequestArgs) {
          const pieces = [findBinary() ?? "pinchpass", ...buildArgs(args)];
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
