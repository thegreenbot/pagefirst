import { createHash, createPublicKey, verify, X509Certificate, type JsonWebKey } from "node:crypto";

/**
 * Trusted publishing for the theme registry (#64). A version is accepted only
 * from the theme-publish workflow running on a release tag in the trusted
 * repository. The workflow proves that with a GitHub Actions OIDC token, so
 * there is no long-lived upload credential to leak. It also sends the
 * Sigstore build-provenance attestation it made for the archive; the
 * registry checks that attestation names the same archive and the same
 * workflow, and keeps it with the version.
 */

export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const OIDC_AUDIENCE = "pagefirst-theme-registry";
export const PUBLISH_WORKFLOW = ".github/workflows/theme-publish.yml";

export class PublishAuthError extends Error {}

export type OidcClaims = {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  repository: string;
  ref: string;
  ref_type: string;
  sha: string;
  event_name: string;
  job_workflow_ref: string;
  run_id: string;
  run_attempt?: string;
  actor?: string;
};

type Jwks = { keys: (JsonWebKey & { kid?: string })[] };
export type JwksFetcher = () => Promise<Jwks>;

const defaultFetcher: JwksFetcher = async () => {
  const response = await fetch(`${OIDC_ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new PublishAuthError(`GitHub JWKS returned ${response.status}`);
  return (await response.json()) as Jwks;
};

let jwksCache: { keys: Jwks; at: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

function base64url(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function keyFor(kid: string, fetcher: JwksFetcher): Promise<JsonWebKey> {
  const fresh = !jwksCache || Date.now() - jwksCache.at > JWKS_TTL_MS;
  if (fresh) jwksCache = { keys: await fetcher(), at: Date.now() };
  let key = jwksCache!.keys.keys.find((candidate) => candidate.kid === kid);
  if (!key && !fresh) {
    // GitHub rotated its keys since we cached them.
    jwksCache = { keys: await fetcher(), at: Date.now() };
    key = jwksCache.keys.keys.find((candidate) => candidate.kid === kid);
  }
  if (!key) throw new PublishAuthError("OIDC token is signed by an unknown key");
  return key;
}

/** Verifies a GitHub Actions OIDC token's RS256 signature, issuer, audience and time window. */
export async function verifyOidcToken(token: string, fetcher: JwksFetcher = defaultFetcher, now = Date.now()): Promise<OidcClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new PublishAuthError("OIDC token is malformed");
  let header: { alg?: string; kid?: string };
  let claims: OidcClaims;
  try {
    header = JSON.parse(base64url(parts[0]!).toString("utf8"));
    claims = JSON.parse(base64url(parts[1]!).toString("utf8"));
  } catch {
    throw new PublishAuthError("OIDC token is malformed");
  }
  if (header.alg !== "RS256" || !header.kid) throw new PublishAuthError("OIDC token must be RS256 with a key id");
  const jwk = await keyFor(header.kid, fetcher);
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, base64url(parts[2]!));
  if (!valid) throw new PublishAuthError("OIDC token signature is invalid");
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== OIDC_ISSUER) throw new PublishAuthError("OIDC token is not from GitHub Actions");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(OIDC_AUDIENCE)) throw new PublishAuthError(`OIDC token audience must be ${OIDC_AUDIENCE}`);
  if (typeof claims.exp !== "number" || claims.exp < seconds - 60) throw new PublishAuthError("OIDC token has expired");
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) throw new PublishAuthError("OIDC token is not valid yet");
  return claims;
}

/** For tests: forget cached GitHub keys. */
export function clearJwksCache(): void {
  jwksCache = null;
}

export function trustedRepository(): string {
  return process.env.THEME_REGISTRY_TRUSTED_REPOSITORY || "thegreenbot/pagefirst";
}

/** The release tag a version must come from: theme-<dir>-v<version>, where dir is the name after @pagefirst/. */
export function releaseTag(name: string, version: string): string {
  const match = /^@pagefirst\/([a-z0-9-]+)$/.exec(name);
  if (!match) throw new PublishAuthError(`${name}: the registry lists first-party @pagefirst themes only`);
  return `theme-${match[1]}-v${version}`;
}

/** The token must come from the publish workflow, pushed as this version's tag, in the trusted repository. */
export function checkPublisher(claims: OidcClaims, name: string, version: string): void {
  const repo = trustedRepository();
  const tag = `refs/tags/${releaseTag(name, version)}`;
  if (claims.repository !== repo) throw new PublishAuthError(`Only ${repo} may publish themes`);
  if (claims.event_name !== "push" || claims.ref_type !== "tag" || claims.ref !== tag) {
    throw new PublishAuthError(`${name}@${version} must be published from a push of tag ${tag.slice("refs/tags/".length)}`);
  }
  if (claims.job_workflow_ref !== `${repo}/${PUBLISH_WORKFLOW}@${tag}`) {
    throw new PublishAuthError(`Themes may only be published by ${PUBLISH_WORKFLOW}`);
  }
}

type SigstoreBundle = {
  mediaType?: string;
  verificationMaterial?: { certificate?: { rawBytes?: string }; x509CertificateChain?: { certificates?: { rawBytes?: string }[] } };
  dsseEnvelope?: { payload?: string; payloadType?: string; signatures?: { sig?: string }[] };
};

/** DSSE pre-authentication encoding, which the attestation's signature covers. */
function pae(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${body.length} `), body]);
}

/**
 * Checks the Sigstore build-provenance attestation the workflow made for the
 * archive: its signature verifies with the certificate inside it, the
 * certificate was issued to the publish workflow at this tag, and the signed
 * statement's subject is exactly this archive. Chaining the certificate to
 * Sigstore's root and the transparency-log entry are checked in CI by
 * `gh attestation verify` before upload; the registry keeps the bundle so
 * anyone can re-verify it later.
 */
export function checkAttestation(bundle: unknown, archive: Uint8Array, name: string, version: string): void {
  const b = bundle as SigstoreBundle;
  const envelope = b?.dsseEnvelope;
  const rawCert = b?.verificationMaterial?.certificate?.rawBytes ?? b?.verificationMaterial?.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (!envelope?.payload || envelope.payloadType !== "application/vnd.in-toto+json" || !envelope.signatures?.[0]?.sig || !rawCert) {
    throw new PublishAuthError("The attestation is not a Sigstore DSSE bundle");
  }
  const cert = new X509Certificate(Buffer.from(rawCert, "base64"));
  const body = Buffer.from(envelope.payload, "base64");
  if (!verify("sha256", pae(envelope.payloadType, body), cert.publicKey, Buffer.from(envelope.signatures[0].sig, "base64"))) {
    throw new PublishAuthError("The attestation signature does not verify");
  }
  const repo = trustedRepository();
  const identity = `URI:https://github.com/${repo}/${PUBLISH_WORKFLOW}@refs/tags/${releaseTag(name, version)}`;
  if (!(cert.subjectAltName ?? "").split(", ").includes(identity)) {
    throw new PublishAuthError("The attestation was not made by the publish workflow for this tag");
  }
  let statement: { subject?: { digest?: { sha256?: string } }[] };
  try {
    statement = JSON.parse(body.toString("utf8"));
  } catch {
    throw new PublishAuthError("The attestation statement is not JSON");
  }
  const digest = createHash("sha256").update(archive).digest("hex");
  if (!statement.subject?.some((subject) => subject.digest?.sha256 === digest)) {
    throw new PublishAuthError("The attestation is for a different archive");
  }
}
