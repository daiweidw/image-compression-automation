export type ImageStatus =
  | "pending"
  | "queued"
  | "compressing"
  | "compressed"
  | "source_changed"
  | "output_missing"
  | "failed"
  | "unsupported";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "cancelled";

export type OutputConflictStrategy = "overwrite" | "skip" | "suffix";

export const TINYPNG_FREE_MONTHLY_LIMIT = 500;

export type TinyPngQuotaStatus = "available" | "warning" | "exhausted" | "unknown";
export type TinyPngUsageSource = "compression" | "validation" | "cache" | null;

export interface TinyPngUsage {
  configured: boolean;
  used: number | null;
  limit: number;
  remaining: number | null;
  status: TinyPngQuotaStatus;
  updatedAt: string | null;
  stale: boolean;
  source: TinyPngUsageSource;
}

export interface ApiKeyState {
  configured: boolean;
  lastValidationStatus: "valid" | "invalid" | "unknown";
  lastValidatedAt: string | null;
  compressionCount: number | null;
}

export interface SettingsResponse {
  configured: boolean;
  outputMode: "automatic" | "custom";
  outputDir: string;
  sessionOutputDir: string | null;
  autoCompressOnImport: boolean;
  recursive: boolean;
  compressionConcurrency: number;
  conflictStrategy: OutputConflictStrategy;
  apiKey: ApiKeyState;
}

export interface UpdateSettingsRequest {
  outputMode: "automatic" | "custom";
  outputDir: string;
  recursive: boolean;
  compressionConcurrency: number;
  conflictStrategy: OutputConflictStrategy;
  createOutputDir: boolean;
  apiKeyAction: "keep" | "replace";
  apiKey?: string | null;
}

export interface UpdateAutoCompressRequest {
  enabled: boolean;
}

export interface LocalAppEvent {
  type: string;
  entityId: string | null;
  scanId?: string;
  imageStatus?: ImageStatus;
  errorCode?: string;
  errorMessage?: string;
  occurredAt: string;
}

export interface ImageItem {
  id: string;
  filename: string;
  relativePath: string;
  sourceDirectory: string;
  extension: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  sourceSize: number;
  sourceMtime: string;
  status: ImageStatus;
  compressedAt: string | null;
  outputSize: number | null;
  savedBytes: number | null;
  savedRatio: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryItemId: string | null;
}

export interface ImageListResponse {
  items: ImageItem[];
  page: number;
  pageSize: number;
  total: number;
  summary: Record<ImageStatus, number> & {
    sourceBytes: number;
    outputBytes: number;
    savedBytes: number;
  };
}

export interface ScanState {
  id: string | null;
  status: "idle" | "running" | "succeeded" | "stopped" | "failed";
  sourceLabel: string | null;
  discoveredCount: number;
  processedCount: number;
  warningCount: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobItemView {
  id: string;
  imageId: string;
  filename: string;
  relativePath: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  inputSize: number | null;
  outputSize: number | null;
  savedBytes: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobView {
  id: string;
  status: JobStatus;
  outputDir: string;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
  inputBytes: number;
  outputBytes: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  items: JobItemView[];
}

export interface JobListResponse {
  items: JobView[];
  page: number;
  pageSize: number;
  total: number;
}

export interface DesktopCapabilities {
  desktop: boolean;
  nativeDirectoryPicker: boolean;
  fileDropPaths: boolean;
  revealInFinder: boolean;
  encryptedSecretStorage: boolean;
}

export interface ApplicationStatus {
  shuttingDown: boolean;
  activeJobs: {
    queued: number;
    running: number;
  };
}

export interface ShutdownRequest {
  confirmActiveJobs: boolean;
}

export interface ShutdownResponse {
  accepted: boolean;
}

export interface ApiSuccess<T> {
  data: T;
  meta: { requestId: string };
}

export interface ApiFailure {
  error: { code: string; message: string; details?: unknown };
  meta: { requestId: string };
}
