import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  browserOnlyE2eSpecs,
  dedicatedE2eSpecs,
  serverCoupledE2eSpecs,
} from "../e2e/test-groups.js";

test("standard E2E specs belong to one capability group", () => {
  const grouped = [...serverCoupledE2eSpecs, ...browserOnlyE2eSpecs, ...dedicatedE2eSpecs];
  const standardSpecs = fs.readdirSync(path.resolve("e2e"))
    .filter((name) => name.endsWith(".spec.ts") && name !== "auth-login-only.spec.ts")
    .sort();

  assert.equal(new Set(grouped).size, grouped.length, "E2E capability groups must not overlap");
  assert.deepEqual([...grouped].sort(), standardSpecs);
});
