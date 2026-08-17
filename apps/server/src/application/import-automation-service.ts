import type { ImageStatus } from "@ica/contracts";
import { AppError, errorMessage } from "../errors.js";
import type { ImageService } from "./image-service.js";
import type { JobService } from "./job-service.js";
import type { ScanImageEvent } from "./scanner-service.js";
import type { SettingsService } from "./settings-service.js";

export interface ImportAutomationEvent {
  type: "image.detected" | "auto-job.created" | "auto-job.failed";
  imageId: string;
  scanId: string;
  imageStatus?: ImageStatus;
  errorCode?: string;
  errorMessage?: string;
}

export class ImportAutomationService {
  private onChange: (event: ImportAutomationEvent) => void = () => undefined;

  constructor(
    private readonly settings: SettingsService,
    private readonly images: ImageService,
    private readonly jobs: JobService
  ) {}

  setOnChange(listener: (event: ImportAutomationEvent) => void): void {
    this.onChange = listener;
  }

  async handleDetected(event: ScanImageEvent): Promise<void> {
    if (!event.newlyAdded) return;
    try {
      const image = await this.images.getById(event.imageId);
      this.onChange({
        type: "image.detected",
        imageId: event.imageId,
        scanId: event.scanId,
        imageStatus: image.status
      });

      const settings = await this.settings.load();
      if (!settings?.autoCompressOnImport || image.status !== "pending") return;
      await this.jobs.create(`auto:${event.scanId}:${event.imageId}`, [event.imageId], false);
      this.onChange({ type: "auto-job.created", imageId: event.imageId, scanId: event.scanId });
    } catch (error) {
      this.onChange({
        type: "auto-job.failed",
        imageId: event.imageId,
        scanId: event.scanId,
        errorCode: error instanceof AppError ? error.code : "AUTO_COMPRESS_FAILED",
        errorMessage: errorMessage(error)
      });
    }
  }
}
