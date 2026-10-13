import { test } from "node:test";
import assert from "node:assert/strict";

import { buildArgs, chooseVia } from "../dist/args.js";

test("builds the base request with -json", () => {
  assert.deepEqual(buildArgs({ names: ["API_KEY"] }), ["request", "API_KEY", "-json"]);
});

test("includes every optional flag in CLI order", () => {
  assert.deepEqual(
    buildArgs({ names: ["A", "B"], tunnel: true, note: "hi", ttl: 5, out: "secrets/.env" }),
    ["request", "A", "B", "-json", "-tunnel", "-note", "hi", "-ttl", "5", "-out", "secrets/.env"],
  );
});

test("passes ttl 0 through and omits unset flags", () => {
  assert.deepEqual(buildArgs({ names: ["A"], ttl: 0 }), ["request", "A", "-json", "-ttl", "0"]);
});

test("ignores tunnel when false and note when empty", () => {
  assert.deepEqual(buildArgs({ names: ["A"], tunnel: false, note: "" }), ["request", "A", "-json"]);
});

test("chooseVia defaults to the modal in the TUI and the link elsewhere", () => {
  assert.deepEqual(chooseVia(undefined, undefined, "tui"), { via: "modal", downgraded: false });
  assert.deepEqual(chooseVia("auto", undefined, "rpc"), { via: "link", downgraded: false });
  assert.deepEqual(chooseVia("auto", undefined, "print"), { via: "link", downgraded: false });
});

test("chooseVia forces the link for a tunnel even in the TUI", () => {
  assert.deepEqual(chooseVia(undefined, true, "tui"), { via: "link", downgraded: false });
  assert.deepEqual(chooseVia("modal", true, "tui"), { via: "link", downgraded: true });
});

test("chooseVia honors explicit modal in the TUI and downgrades it elsewhere", () => {
  assert.deepEqual(chooseVia("modal", undefined, "tui"), { via: "modal", downgraded: false });
  assert.deepEqual(chooseVia("modal", undefined, "rpc"), { via: "link", downgraded: true });
  assert.deepEqual(chooseVia("link", undefined, "tui"), { via: "link", downgraded: false });
});
