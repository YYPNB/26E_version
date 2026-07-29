import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecordingName,
  formatBytes,
  formatDuration,
  normalizeDeviceAddress,
  sanitizeTestName,
  selectRecordingMime,
} from "../core.mjs";

test("normalizes plain device addresses to the Maix WebRTC signaling port", () => {
  const result = normalizeDeviceAddress("192.168.10.25");
  assert.equal(result.host, "192.168.10.25");
  assert.equal(result.port, 8001);
  assert.match(result.websocketUrl, /^ws:\/\/192\.168\.10\.25:8001\/[A-Za-z0-9]{10}$/);
});

test("honors an explicitly supplied signaling port", () => {
  const result = normalizeDeviceAddress("http://maixcam.local:9001");
  assert.equal(result.host, "maixcam.local");
  assert.equal(result.port, 9001);
});

test("rejects an empty address", () => {
  assert.throws(() => normalizeDeviceAddress("  "), /IP/);
});

test("sanitizes Windows file names", () => {
  assert.equal(sanitizeTestName(' test: 01 / ball* '), "test__01___ball_");
});

test("builds a deterministic recording name", () => {
  const date = new Date(2026, 6, 29, 8, 5, 4);
  assert.equal(buildRecordingName("run 1", date), "run_1_20260729_080504.webm");
});

test("formats durations and byte counts", () => {
  assert.equal(formatDuration(65_900), "01:05");
  assert.equal(formatDuration(3_661_000), "01:01:01");
  assert.equal(formatBytes(1_572_864), "1.5 MB");
});

test("selects the first supported recorder format", () => {
  const Recorder = { isTypeSupported: (mime) => mime.includes("vp8") };
  assert.equal(selectRecordingMime(Recorder), "video/webm;codecs=vp8");
});
