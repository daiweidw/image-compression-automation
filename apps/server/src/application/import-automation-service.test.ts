import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { ImportAutomationService, type ImportAutomationEvent } from "./import-automation-service.js";

describe("ImportAutomationService", () => {
  it("only selects a newly detected image while automatic compression is off", async () => {
    const create = vi.fn();
    const service = new ImportAutomationService(
      { load: vi.fn(async () => ({ autoCompressOnImport: false })) } as any,
      { getById: vi.fn(async () => ({ status: "pending" })) } as any,
      { create } as any
    );
    const events: ImportAutomationEvent[] = [];
    service.setOnChange((event) => events.push(event));

    await service.handleDetected({ scanId: "scan-1", imageId: "image-1", newlyAdded: true });

    expect(create).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "image.detected", scanId: "scan-1", imageId: "image-1", imageStatus: "pending" }]);
  });

  it("creates one idempotent task for a new pending image while enabled", async () => {
    const create = vi.fn(async () => ({ id: "job-1" }));
    const service = new ImportAutomationService(
      { load: vi.fn(async () => ({ autoCompressOnImport: true })) } as any,
      { getById: vi.fn(async () => ({ status: "pending" })) } as any,
      { create } as any
    );
    const events: ImportAutomationEvent[] = [];
    service.setOnChange((event) => events.push(event));

    await service.handleDetected({ scanId: "scan-1", imageId: "image-1", newlyAdded: true });

    expect(create).toHaveBeenCalledWith("auto:scan-1:image-1", ["image-1"], false);
    expect(events.map((event) => event.type)).toEqual(["image.detected", "auto-job.created"]);
  });

  it("keeps task creation errors isolated from scanning", async () => {
    const service = new ImportAutomationService(
      { load: vi.fn(async () => ({ autoCompressOnImport: true })) } as any,
      { getById: vi.fn(async () => ({ status: "pending" })) } as any,
      { create: vi.fn(async () => { throw new AppError("QUOTA_EXHAUSTED", "额度已用尽", 409); }) } as any
    );
    const events: ImportAutomationEvent[] = [];
    service.setOnChange((event) => events.push(event));

    await expect(service.handleDetected({ scanId: "scan-1", imageId: "image-1", newlyAdded: true })).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "auto-job.failed", errorCode: "QUOTA_EXHAUSTED", errorMessage: "额度已用尽" });
  });

  it("does not automatically retry an imported failed item", async () => {
    const create = vi.fn();
    const service = new ImportAutomationService(
      { load: vi.fn(async () => ({ autoCompressOnImport: true })) } as any,
      { getById: vi.fn(async () => ({ status: "failed" })) } as any,
      { create } as any
    );

    await service.handleDetected({ scanId: "scan-1", imageId: "image-1", newlyAdded: true });
    expect(create).not.toHaveBeenCalled();
  });
});
