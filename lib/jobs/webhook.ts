import { createHmac, timingSafeEqual } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { open } from "@/lib/crypto/secretbox";
import { query, transaction } from "@/lib/db/client";
import { publicLookup, validateWebhookUrl } from "@/lib/net/public-host";
import { buildReport } from "./report";
import { jobCounts, readJobById } from "./store";

/**
 * Completion webhooks for bulk jobs (#40). One POST when a job finishes, signed
 * with the secret the caller chose: `Pagefirst-Signature: t=<unix>,v1=<hmac>`,
 * where the HMAC-SHA256 covers `<t>.<body>`. A failed delivery is retried on a
 * backoff, then given up; the job's result is always available by polling.
 */

/** Delay before attempt 2, 3, 4 and 5. After the fifth failure the webhook is marked failed. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const TIMEOUT_MS = 5_000;
const LEASE_MS = 2 * 60_000;

export function sign(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** For receivers: checks a signature header, rejecting one older than `toleranceSeconds`. */
export function verifySignature(secret: string, header: string, body: string, now = Date.now(), toleranceSeconds = 300): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, timestamp, body).split("v1=")[1]!, "hex");
  return timingSafeEqual(expected, Buffer.from(match[2]!, "hex"));
}

export type Send = (url: URL, headers: Record<string, string>, body: string) => Promise<number>;

/** POSTs with a connect-time public-address check, no redirects and a short timeout. Resolves to the status code. */
export const httpsSend: Send = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, lookup: publicLookup as never, timeout: TIMEOUT_MS }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });

type Due = { id: string; webhook_url: string; webhook_secret: string; webhook_attempts: number };

async function payloadFor(jobId: string): Promise<string | null> {
  const job = await readJobById(jobId);
  if (!job) return null;
  const report = buildReport(job, await jobCounts(jobId), []);
  // Counts and status only: the receiver fetches per-item results (and the CSV) with its own credential.
  return JSON.stringify({ event: "job.completed", job: report.job, counts: report.counts });
}

/**
 * Sends webhooks that are due. Each is leased before sending, so two workers
 * never send the same one, and a crash mid-send is retried after the lease.
 */
export async function deliverDue(limit = 5, send: Send = httpsSend, now = new Date()): Promise<{ sent: number; failed: number }> {
  const due = await transaction(async (client) => {
    const { rows } = await client.query<Due>(
      `SELECT id, webhook_url, webhook_secret, webhook_attempts FROM jobs
        WHERE webhook_state = 'pending' AND webhook_next_at <= $1
        ORDER BY webhook_next_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    if (rows.length > 0) {
      await client.query("UPDATE jobs SET webhook_next_at = $2 WHERE id = ANY($1::text[])", [rows.map((row) => row.id), new Date(now.getTime() + LEASE_MS)]);
    }
    return rows;
  });
  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const attempt = row.webhook_attempts + 1;
    let ok = false;
    try {
      const body = await payloadFor(row.id);
      if (body) {
        const url = validateWebhookUrl(row.webhook_url);
        const timestamp = Math.floor(now.getTime() / 1000);
        const status = await send(
          url,
          { "Content-Type": "application/json", "User-Agent": "Pagefirst-Webhook/1", "Pagefirst-Signature": sign(open(row.webhook_secret, `job-webhook:${row.id}`), timestamp, body), "Pagefirst-Delivery": `${row.id}:${attempt}` },
          body,
        );
        ok = status >= 200 && status < 300;
      }
    } catch {
      ok = false;
    }
    if (ok) {
      sent += 1;
      await query("UPDATE jobs SET webhook_state = 'sent', webhook_attempts = $2 WHERE id = $1", [row.id, attempt]);
    } else {
      failed += 1;
      const delay = RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) await query("UPDATE jobs SET webhook_state = 'failed', webhook_attempts = $2 WHERE id = $1", [row.id, attempt]);
      else await query("UPDATE jobs SET webhook_attempts = $2, webhook_next_at = $3 WHERE id = $1", [row.id, attempt, new Date(now.getTime() + delay)]);
    }
  }
  return { sent, failed };
}
