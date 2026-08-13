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
  | "paused"
  | "awaiting_resume"
  | "completed"
  | "completed_with_errors"
  | "cancelled";

export type OutputConflictStrategy = "overwrite" | "skip" | "suffix";

export interface ApiKeyState {
  configured: boolean;
  lastValidationStatus: "valid" | "invalid" | "unknown";
  lastValidatedAt: string | null;
  compressionCount: number | null;
}

export interface SettingsResponse {
  configured: boolean;
  sourceDir: string;
  outputDir: string;
  recursive: boolean;
  compressionConcurrency: number;
  watchEnabled: boolean;
  autoCompress: boolean;
  conflictStrategy: OutputConflictStrategy;
  apiKey: ApiKeyState;
}

export interface UpdateSettingsRequest {
  sourceDir: string;
  outputDir: string;
  recursive: boolean;
  compressionConcurrency: number;
  watchEnabled: boolean;
  autoCompress: boolean;
  conflictStrategy: OutputConflictStrategy;
  createOutputDir: boolean;
  apiKeyAction: "keep" | "replace";
  apiKey?: string | null;
}

export interface ImageItem {
  id: string;
  filename: string;
  relativePath: string;
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
  status: "idle" | "running" | "succeeded" | "failed";
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
  status: "queued" | "running" | "paused" | "awaiting_resume" | "succeeded" | "failed" | "cancelled" | "skipped";
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

export interface JobHistoryResponse {
  items: JobView[];
  page: number;
  pageSize: number;
  total: number;
}

export interface WatchState {
  enabled: boolean;
  watching: boolean;
  autoCompress: boolean;
  pendingChanges: number;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface DesktopCapabilities {
  desktop: boolean;
  nativeDirectoryPicker: boolean;
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
