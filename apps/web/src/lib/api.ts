import type { ApiFailure, ApiSuccess } from "@ica/contracts";

let localToken = "";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export async function initializeSession(): Promise<void> {
  const response = await fetch("/api/session");
  const payload = (await response.json()) as ApiSuccess<{ token: string }>;
  localToken = payload.data.token;
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init?.method && init.method !== "GET") headers.set("X-Local-App-Token", localToken);
  const response = await fetch(url, { ...init, headers });
  const payload = (await response.json()) as ApiSuccess<T> | ApiFailure;
  if (!response.ok || "error" in payload) {
    const failure = payload as ApiFailure;
    throw new ApiError(failure.error.code, failure.error.message, failure.error.details);
  }
  return (payload as ApiSuccess<T>).data;
}
