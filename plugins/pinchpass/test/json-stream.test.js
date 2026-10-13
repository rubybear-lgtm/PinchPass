import { test } from "node:test";
import assert from "node:assert/strict";

import { takeJsonBlobs } from "../dist/json-stream.js";

test("parses a single complete object", () => {
  const { blobs, rest } = takeJsonBlobs('{"success":true,"names":["A"]}');
  assert.deepEqual(blobs, [{ success: true, names: ["A"] }]);
  assert.equal(rest, "");
});

test("parses two pretty-printed objects and keeps no residue", () => {
  const input = '{\n  "success": true,\n  "url": "http://x"\n}\n' + '{\n  "success": true,\n  "port": 1\n}\n';
  const { blobs, rest } = takeJsonBlobs(input);
  assert.equal(blobs.length, 2);
  assert.deepEqual(blobs[0], { success: true, url: "http://x" });
  assert.deepEqual(blobs[1], { success: true, port: 1 });
  assert.equal(rest, "");
});

test("holds a partial object in rest until it completes", () => {
  const chunk1 = '{"success":true,"ur';
  const a = takeJsonBlobs(chunk1);
  assert.deepEqual(a.blobs, []);
  assert.equal(a.rest, chunk1);

  const b = takeJsonBlobs(a.rest + 'l":"http://y"}');
  assert.deepEqual(b.blobs, [{ success: true, url: "http://y" }]);
  assert.equal(b.rest, "");
});

test("ignores braces and escaped quotes inside strings", () => {
  const { blobs } = takeJsonBlobs('{"message":"a } b { \\"c\\""}');
  assert.deepEqual(blobs, [{ message: 'a } b { "c"' }]);
});

test("skips malformed output but parses the next object", () => {
  const { blobs } = takeJsonBlobs('{"broken":} {"ok":1}');
  assert.deepEqual(blobs, [{ ok: 1 }]);
});

test("does not emit a blob for an unbalanced close", () => {
  const { blobs, rest } = takeJsonBlobs("}}");
  assert.deepEqual(blobs, []);
  assert.equal(rest, "");
});

test("recovers after a stray closing brace", () => {
  const { blobs } = takeJsonBlobs('}} {"ok":1}');
  assert.deepEqual(blobs, [{ ok: 1 }]);
});
