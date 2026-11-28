import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { readTextCapped } from "@/lib/http/body";
import { publishVersion, RegistryError } from "@/lib/theme/registry-store";
import { checkAttestation, checkPublisher, PublishAuthError, verifyOidcToken } from "@/lib/theme/trusted-publishing";

export const dynamic = "force-dynamic";

/** Archives are at most 4 MB unpacked; base64 and the attestation fit well inside this. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const error = (status: number, message: string) => NextResponse.json({ error: message }, { status });

/**
 * Trusted publishing (#64): the theme-publish workflow uploads a version with
 * a GitHub Actions OIDC token, never a stored secret, plus the Sigstore
 * attestation it made for the archive. Authenticated by that token only; no
 * cookie is read, which is why middleware lets it through without an Origin.
 */
export async function POST(request: Request) {
  if (!process.env.THEME_REGISTRY_SIGNING_KEY) return error(503, "This deployment does not publish themes.");
  const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return error(401, "Send a GitHub Actions OIDC token as a Bearer token.");

  let claims;
  try {
    claims = await verifyOidcToken(token);
  } catch (cause) {
    await auditRequest(request, { event: "registry.publish", outcome: "denied", status: 401, errorCode: "oidc", actorSub: null });
    return error(401, cause instanceof PublishAuthError ? cause.message : "OIDC token could not be verified.");
  }
  const actor = `github:${claims.repository}`;

  const read = await readTextCapped(request, MAX_BODY_BYTES);
  if (!read.ok) return error(413, "The upload is too large.");
  let body: { archive?: unknown; scores?: unknown; attestation?: unknown };
  try {
    body = JSON.parse(read.text);
  } catch {
    return error(400, "Send JSON.");
  }
  if (typeof body.archive !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.archive)) return error(400, "archive must be base64.");
  const scores = body.scores && typeof body.scores === "object" && !Array.isArray(body.scores) ? (body.scores as Record<string, unknown>) : null;
  const archive = new Uint8Array(Buffer.from(body.archive, "base64"));

  try {
    const published = await publishVersion(
      archive,
      {
        repository: claims.repository,
        ref: claims.ref,
        sha: claims.sha,
        workflow: claims.job_workflow_ref,
        runId: claims.run_id,
        runAttempt: claims.run_attempt ?? null,
        actor: claims.actor ?? null,
        attestation: body.attestation,
      },
      scores,
      (manifest) => {
        checkPublisher(claims, manifest.name, manifest.version);
        checkAttestation(body.attestation, archive, manifest.name, manifest.version);
      },
    );
    await auditRequest(request, { event: "registry.publish", outcome: "ok", actorSub: actor });
    return NextResponse.json({ name: published.name, version: published.version, integrity: published.integrity }, { status: 201 });
  } catch (cause) {
    const refused = cause instanceof PublishAuthError;
    const invalid = cause instanceof RegistryError;
    const status = refused ? 403 : invalid ? 422 : 500;
    await auditRequest(request, { event: "registry.publish", outcome: refused ? "denied" : "error", status, errorCode: refused ? "publisher" : invalid ? "invalid" : "internal", actorSub: actor });
    if (!refused && !invalid) throw cause;
    return error(status, (cause as Error).message);
  }
}
