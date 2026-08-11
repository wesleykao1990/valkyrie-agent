import test from "node:test";
import assert from "node:assert/strict";
import { routeTask, validateBudget } from "../apps/control-plane/src/policy.ts";

test("routes non-trivial engineering work to Atomic", () => {
  assert.equal(routeTask({ projectId: "ovalo", objective: "Implement pronunciation feedback with tests" }).runtime, "atomic");
});

test("routes long research to Prime", () => {
  assert.equal(routeTask({ projectId: "ovalo", objective: "Research and benchmark three speech architectures" }).runtime, "prime");
});

test("explicit runtime wins", () => {
  assert.equal(routeTask({ projectId: "ovalo", objective: "Anything", runtime: "claude" }).runtime, "claude");
});

test("budget is bounded", () => {
  assert.equal(validateBudget(undefined), 8);
  assert.throws(() => validateBudget(30));
});
