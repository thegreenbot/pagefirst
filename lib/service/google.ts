import { batchUpdate, createDocument, fetchDocument, listDocuments } from "@/lib/google/docs";
import { ServiceError, type GoogleClient } from "./context";

export const realGoogle: GoogleClient = { listDocuments, fetchDocument, createDocument, batchUpdate };

/** Reads the status out of the Docs wrapper's "... failed (404)" message, once, here. */
export function upstreamStatus(err: unknown): number | null {
  const match = err instanceof Error ? /\((\d{3})\)/.exec(err.message) : null;
  return match ? Number(match[1]) : null;
}

export function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Turns a Google failure into a typed error. */
export function toServiceError(err: unknown, fallback: string, redactToken: (text: string) => string): ServiceError {
  if (err instanceof ServiceError) return err;
  const message = redactToken(messageOf(err, fallback));
  const status = upstreamStatus(err);
  if (status === 404) return new ServiceError("not_found", message);
  if (status === 403 || status === 401) return new ServiceError("forbidden", message);
  if (status === 429) return new ServiceError("upstream_quota", message);
  if (message.includes("does not support")) return new ServiceError("unsupported", message);
  return new ServiceError("upstream_error", message);
}
