import { describe, expect, it } from "vitest";
import { deriveImageStatus } from "./image-status.js";

const base = {
  queued: false,
  running: false,
  supported: true,
  sourceHash: "same",
  recordSourceHash: null,
  outputValid: false,
  lastJobFailed: false
};

describe("deriveImageStatus", () => {
  it("prioritizes running and queued states", () => {
    expect(deriveImageStatus({ ...base, running: true, queued: true })).toBe("compressing");
    expect(deriveImageStatus({ ...base, queued: true })).toBe("queued");
  });

  it("detects source changes and missing output", () => {
    expect(deriveImageStatus({ ...base, recordSourceHash: "old" })).toBe("source_changed");
    expect(deriveImageStatus({ ...base, recordSourceHash: "same" })).toBe("output_missing");
  });

  it("marks a matching record with valid output as compressed", () => {
    expect(deriveImageStatus({ ...base, recordSourceHash: "same", outputValid: true })).toBe("compressed");
  });

  it("falls back to failure and pending", () => {
    expect(deriveImageStatus({ ...base, lastJobFailed: true })).toBe("failed");
    expect(deriveImageStatus(base)).toBe("pending");
  });
});
