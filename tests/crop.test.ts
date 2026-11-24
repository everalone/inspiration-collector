import test from "node:test";
import assert from "node:assert/strict";
import { cropRect } from "../core/crop.ts";

const W = 1000, H = 1600;

test("crop adds breathing room around a tight text box", () => {
  const rect = cropRect([100, 100, 300, 140], W, H);
  // pad = max(10, round(min(1000,1600) * .015)) = 15
  assert.equal(rect.left, 85);   // 100 - 15
  assert.equal(rect.top, 145);   // round(0.1 * 1600) - 15
  assert.equal(rect.width, 230); // 200 + 2 * 15
  assert.equal(rect.height, 94); // round(0.04 * 1600) + 2 * 15
});

test("crop clamps at the image edges", () => {
  const rect = cropRect([0, 0, 1000, 1000], W, H);
  assert.deepEqual(rect, { left: 0, top: 0, width: W, height: H });
  const corner = cropRect([980, 970, 1000, 1000], W, H);
  assert.ok(corner.left + corner.width <= W);
  assert.ok(corner.top + corner.height <= H);
});

test("crop keeps a minimum size for degenerate boxes", () => {
  const rect = cropRect([500, 500, 500, 500], W, H);
  assert.ok(rect.width >= 10);
  assert.ok(rect.height >= 10);
});

test("crop never produces negative offsets", () => {
  const rect = cropRect([0, 0, 10, 10], W, H);
  assert.equal(rect.left, 0);
  assert.equal(rect.top, 0);
});
