import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point HOME at an empty temp dir *before* importing the extension, so the
// binary fallback dirs (~/.local/bin, ~/.pi/bin, …) cannot resolve a real
// pinchpass and shadow the fixture.
const root = mkdtempSync(join(tmpdir(), "pinchpass-index-"));
process.env.HOME = join(root, "home");
process.env.PATH = "";
mkdirSync(process.env.HOME, { recursive: true });

const posixOnly = process.platform === "win32" ? { skip: "POSIX shell fixture" } : {};

const mod = await import("../dist/index.js");
let tool;
await mod.default({
  registerTool(definition) {
    tool = definition;
  },
});

const widgetCalls = [];
const ctx = {
  mode: "tui",
  hasUI: true,
  cwd: root,
  ui: { setWidget: (key, content) => widgetCalls.push({ key, content }) },
};

function fakePinchpass(dir, body) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pinchpass");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return dir;
}

const BLOB1 = `{"success":true,"names":["API_KEY"],"url":"http://bore.pub:1234/claim/t","port":1}`;

const BLOB2_OK = `{"success":true,"names":["API_KEY"],"port":1}`;
const BLOB2_FAIL = `{"success":false,"names":["API_KEY"],"port":1}`;

test("tunnel: true in the TUI uses the link and reports success from blob 2", posixOnly, async () => {
  process.env.PATH = fakePinchpass(join(root, "ok"), `printf '%s\\n' '${BLOB1}' '${BLOB2_OK}'`);
  const updates = [];
  const res = await tool.execute(
    "id",
    { names: ["API_KEY"], tunnel: true, via: "auto" },
    undefined,
    (u) => updates.push(u),
    ctx,
  );
  assert.equal(res.details.via, "link");
  assert.equal(res.details.success, true);
  assert.equal(res.isError, false);
  assert.deepEqual(res.details.saved, ["API_KEY"]);
  assert.equal(res.structuredContent.success, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].details.url, "http://bore.pub:1234/claim/t");
  const widget = widgetCalls.filter((c) => c.key === "pinchpass-link");
  assert.ok(
    widget.some((c) => Array.isArray(c.content) && c.content.includes("http://bore.pub:1234/claim/t")),
    "link should be shown in a persistent widget",
  );
  assert.ok(widget.some((c) => c.content === undefined), "widget should be cleared when done");
});

test("a hard CLI failure (blob 1 only, non-zero exit) is an error, not a success", posixOnly, async () => {
  process.env.PATH = fakePinchpass(join(root, "hardfail"), `printf '%s\\n' '${BLOB1}'\nexit 1`);
  const res = await tool.execute(
    "id",
    { names: ["API_KEY"], tunnel: true },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(res.details.success, false);
  assert.equal(res.isError, true);
  assert.equal(res.details.error, "cli-failed");
  assert.deepEqual(res.details.saved, []);
});

test("a reported CLI failure (blob 2 success:false) is an error", posixOnly, async () => {
  process.env.PATH = fakePinchpass(join(root, "timeout"), `printf '%s\\n' '${BLOB1}' '${BLOB2_FAIL}'`);
  const res = await tool.execute("id", { names: ["API_KEY"], via: "link" }, undefined, undefined, ctx);
  assert.equal(res.details.success, false);
  assert.equal(res.isError, true);
  assert.equal(res.details.error, "not-provisioned");
});

test("no JSON output at all is an error", posixOnly, async () => {
  process.env.PATH = fakePinchpass(join(root, "silent"), "exit 0");
  const res = await tool.execute("id", { names: ["API_KEY"], via: "link" }, undefined, undefined, ctx);
  assert.equal(res.details.success, false);
  assert.equal(res.isError, true);
  assert.equal(res.details.error, "no-output");
});

test("via: modal outside the TUI still falls back to the link", posixOnly, async () => {
  process.env.PATH = fakePinchpass(join(root, "rpc"), `printf '%s\\n' '${BLOB1}' '${BLOB2_OK}'`);
  const res = await tool.execute(
    "id",
    { names: ["API_KEY"], via: "modal" },
    undefined,
    undefined,
    { ...ctx, mode: "rpc" },
  );
  assert.equal(res.details.via, "link");
  assert.equal(res.details.success, true);
});

const noColorTheme = { fg: (_c, s) => s, bold: (s) => s };

test("partial render shows the one-time link to the user", () => {
  const comp = tool.renderResult(
    {
      content: [{ type: "text", text: "streamed to the model" }],
      details: { url: "http://127.0.0.1:1234/claim/tok#k=abc", names: ["API_KEY"], via: "link" },
    },
    { isPartial: true, expanded: false },
    noColorTheme,
    {},
  );
  const out = comp.render(200).join("\n");
  assert.match(out, /Open this one-time link/);
  assert.match(out, /http:\/\/127\.0\.0\.1:1234\/claim\/tok#k=abc/);
  assert.match(out, /Waiting for submission/);
});

test("partial render before the link exists shows a start message", () => {
  const comp = tool.renderResult(
    { content: [], details: {} },
    { isPartial: true, expanded: false },
    noColorTheme,
    {},
  );
  assert.match(comp.render(200).join("\n"), /Starting pinchpass/);
});
