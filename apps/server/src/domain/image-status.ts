import type { ImageStatus } from "@ica/contracts";

export interface ImageStatusFacts {
  queued: boolean;
  running: boolean;
  supported: boolean;
  sourceHash: string | null;
  recordSourceHash: string | null;
  outputValid: boolean;
  lastJobFailed: boolean;
}

export function deriveImageStatus(facts: ImageStatusFacts): ImageStatus {
  if (facts.running) return "compressing";
  if (facts.queued) return "queued";
  if (!facts.supported) return "unsupported";
  if (facts.recordSourceHash && facts.sourceHash !== facts.recordSourceHash) return "source_changed";
  if (facts.recordSourceHash && !facts.outputValid) return "output_missing";
  if (facts.recordSourceHash && facts.outputValid) return "compressed";
  if (facts.lastJobFailed) return "failed";
  return "pending";
}
