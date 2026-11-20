import assert from "node:assert/strict";
import test from "node:test";

process.env.WORKER_API_KEY = "worker-secret";
process.env.PLANNER_API_KEY = "planner-secret";
process.env.MANAGER_API_KEY = "manager-secret";
process.env.UI_API_KEY = "ui-secret";

const { deriveRoleKey, rewriteJsonBody, safeEqual } = await import("../src/server.mjs");

test("role keys are deterministic and isolated by role", () => {
  assert.equal(
    deriveRoleKey("shared-root-secret", "worker"),
    deriveRoleKey("shared-root-secret", "worker"),
  );
  assert.notEqual(
    deriveRoleKey("shared-root-secret", "worker"),
    deriveRoleKey("shared-root-secret", "planner"),
  );
});

test("safeEqual accepts only the exact non-empty key", () => {
  assert.equal(safeEqual("worker-secret", "worker-secret"), true);
  assert.equal(safeEqual("worker-secret", "planner-secret"), false);
  assert.equal(safeEqual("", ""), false);
});

test("role model replaces auto and preserves explicit model", () => {
  const role = { name: "worker", model: "auto:worker" };
  const rewritten = JSON.parse(rewriteJsonBody(Buffer.from('{"model":"auto","messages":[]}'), "application/json", role));
  assert.equal(rewritten.model, "auto:worker");
  assert.equal(rewritten.metadata.nextgen_role, "worker");

  const explicit = JSON.parse(rewriteJsonBody(Buffer.from('{"model":"gpt-explicit"}'), "application/json", role));
  assert.equal(explicit.model, "gpt-explicit");
});

test("non-json request bodies pass through unchanged", () => {
  const body = Buffer.from("audio bytes");
  assert.equal(rewriteJsonBody(body, "audio/wav", { name: "worker", model: "auto:worker" }), body);
});
