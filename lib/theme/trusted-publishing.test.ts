import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { readThemeDir } from "./package";
import { latestVersion } from "./registry-store";
import { archiveIntegrity, packTheme } from "./tarball";
import {
  checkAttestation,
  checkPublisher,
  clearJwksCache,
  OIDC_AUDIENCE,
  OIDC_ISSUER,
  verifyOidcToken,
  type OidcClaims,
} from "./trusted-publishing";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const jwks = async () => ({ keys: [jwk] });

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

function jwt(claims: Partial<OidcClaims> & Record<string, unknown>, { key = rsa.privateKey, kid = "k1", alg = "RS256" }: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const head = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key))}`;
}

const TAG = "refs/tags/theme-editorial-v1.0.0";
const now = Math.floor(Date.now() / 1000);
const goodClaims: OidcClaims = {
  iss: OIDC_ISSUER,
  aud: OIDC_AUDIENCE,
  exp: now + 300,
  nbf: now - 10,
  repository: "thegreenbot/pagefirst",
  ref: TAG,
  ref_type: "tag",
  sha: "0123456789abcdef0123456789abcdef01234567",
  event_name: "push",
  job_workflow_ref: `thegreenbot/pagefirst/.github/workflows/theme-publish.yml@${TAG}`,
  run_id: "42",
};

describe("GitHub OIDC tokens (#64)", () => {
  afterEach(() => clearJwksCache());

  test("a token signed by GitHub's key with the registry audience verifies", async () => {
    const claims = await verifyOidcToken(jwt(goodClaims), jwks);
    assert.equal(claims.repository, "thegreenbot/pagefirst");
  });

  const bad: [string, () => string, RegExp][] = [
    ["a forged signature", () => jwt(goodClaims, { key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey }), /signature is invalid/],
    ["an unknown key id", () => jwt(goodClaims, { kid: "other" }), /unknown key/],
    ["another algorithm", () => jwt(goodClaims, { alg: "HS256" }), /RS256/],
    ["another issuer", () => jwt({ ...goodClaims, iss: "https://evil.example" }), /not from GitHub Actions/],
    ["another audience", () => jwt({ ...goodClaims, aud: "sigstore" }), /audience/],
    ["an expired token", () => jwt({ ...goodClaims, exp: now - 3600 }), /expired/],
    ["a token not valid yet", () => jwt({ ...goodClaims, nbf: now + 3600 }), /not valid yet/],
    ["garbage", () => "a.b", /malformed/],
  ];
  for (const [what, token, error] of bad) {
    test(`refuses ${what}`, async () => {
      await assert.rejects(verifyOidcToken(token(), jwks), error);
    });
  }

  test("refetches GitHub's keys once when a new key id appears", async () => {
    let calls = 0;
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetcher = async () => {
      calls += 1;
      return { keys: calls === 1 ? [jwk] : [jwk, { ...rotated.publicKey.export({ format: "jwk" }), kid: "k2" }] };
    };
    await verifyOidcToken(jwt(goodClaims), fetcher);
    await verifyOidcToken(jwt(goodClaims, { key: rotated.privateKey, kid: "k2" }), fetcher);
    assert.equal(calls, 2);
  });
});

describe("who may publish (#64)", () => {
  test("the publish workflow on the version's tag in the trusted repository", () => {
    assert.doesNotThrow(() => checkPublisher(goodClaims, "@pagefirst/editorial", "1.0.0"));
  });

  const refused: [string, Partial<OidcClaims>, string, RegExp][] = [
    ["a fork", { repository: "someone/pagefirst" }, "1.0.0", /Only thegreenbot\/pagefirst/],
    ["a branch push", { ref: "refs/heads/main", ref_type: "branch" }, "1.0.0", /tag theme-editorial-v1.0.0/],
    ["another version's tag", {}, "1.0.1", /tag theme-editorial-v1.0.1/],
    ["a pull request run", { event_name: "pull_request" }, "1.0.0", /must be published from a push/],
    ["another workflow", { job_workflow_ref: `thegreenbot/pagefirst/.github/workflows/ci.yml@${TAG}` }, "1.0.0", /theme-publish.yml/],
  ];
  for (const [what, change, version, error] of refused) {
    test(`refuses ${what}`, () => assert.throws(() => checkPublisher({ ...goodClaims, ...change }, "@pagefirst/editorial", version), error));
  }

  test("refuses a theme outside @pagefirst", () => {
    assert.throws(() => checkPublisher(goodClaims, "@someone/theme", "1.0.0"), /first-party @pagefirst themes only/);
  });
});

/** A Sigstore-shaped bundle: an in-toto statement for `subject`, DSSE-signed by a cert with `san`. */
function attestation(dir: string, subject: Uint8Array, san: string) {
  const key = path.join(dir, "leaf.key");
  const cert = path.join(dir, "leaf.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/O=sigstore.dev", "-addext", `subjectAltName=URI:${san}`], { stdio: "ignore" });
  const statement = Buffer.from(
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "theme.tgz", digest: { sha256: createHash("sha256").update(subject).digest("hex") } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {},
    }),
  );
  const type = "application/vnd.in-toto+json";
  const pae = Buffer.concat([Buffer.from(`DSSEv1 ${type.length} ${type} ${statement.length} `), statement]);
  const sig = sign("sha256", pae, readFileSync(key));
  const der = Buffer.from(readFileSync(cert, "utf8").replace(/-----[^-]+-----|\s/g, ""), "base64");
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { certificate: { rawBytes: der.toString("base64") } },
    dsseEnvelope: { payload: statement.toString("base64"), payloadType: type, signatures: [{ sig: sig.toString("base64") }] },
  };
}

const IDENTITY = `https://github.com/thegreenbot/pagefirst/.github/workflows/theme-publish.yml@${TAG}`;

describe("Sigstore attestations (#64)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "attest-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("an attestation for this archive from the publish workflow passes", () => {
    const archive = packTheme(readThemeDir("themes/editorial"));
    assert.doesNotThrow(() => checkAttestation(attestation(dir, archive, IDENTITY), archive, "@pagefirst/editorial", "1.0.0"));
  });

  test("refuses an attestation for a different archive", () => {
    const archive = packTheme(readThemeDir("themes/editorial"));
    assert.throws(() => checkAttestation(attestation(dir, new Uint8Array([1]), IDENTITY), archive, "@pagefirst/editorial", "1.0.0"), /different archive/);
  });

  test("refuses an attestation made by another workflow", () => {
    const archive = packTheme(readThemeDir("themes/editorial"));
    const other = IDENTITY.replace("theme-publish.yml", "ci.yml");
    assert.throws(() => checkAttestation(attestation(dir, archive, other), archive, "@pagefirst/editorial", "1.0.0"), /not made by the publish workflow/);
  });

  test("refuses an attestation whose statement was swapped after signing", () => {
    const archive = packTheme(readThemeDir("themes/editorial"));
    const bundle = attestation(dir, new Uint8Array([1]), IDENTITY);
    const real = attestation(dir, archive, IDENTITY);
    bundle.dsseEnvelope.payload = real.dsseEnvelope.payload;
    assert.throws(() => checkAttestation(bundle, archive, "@pagefirst/editorial", "1.0.0"), /signature does not verify/);
  });

  test("refuses something that is not a bundle", () => {
    assert.throws(() => checkAttestation({}, new Uint8Array(), "@pagefirst/editorial", "1.0.0"), /not a Sigstore DSSE bundle/);
  });
});

const url = testDatabaseUrl();

describe("POST /api/registry/versions (#64)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  before(async () => {
    await resetTestDatabase(url!);
    dir = mkdtempSync(path.join(tmpdir(), "attest-"));
    const ed = generateKeyPairSync("ed25519");
    process.env.THEME_REGISTRY_SIGNING_KEY = ed.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.THEME_REGISTRY_PUBLIC_KEYS = ed.publicKey.export({ type: "spki", format: "pem" }).toString();
    // The route fetches GitHub's JWKS; serve ours instead.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === `${OIDC_ISSUER}/.well-known/jwks`) return new Response(JSON.stringify({ keys: [jwk] }));
      throw new Error(`unexpected fetch ${String(input)}`);
    }) as typeof fetch;
    writeFileSync(path.join(dir, ".keep"), "");
  });
  after(async () => {
    globalThis.fetch = realFetch;
    clearJwksCache();
    delete process.env.THEME_REGISTRY_SIGNING_KEY;
    delete process.env.THEME_REGISTRY_PUBLIC_KEYS;
    rmSync(dir, { recursive: true, force: true });
    await closeDatabase();
  });

  async function post(token: string | null, body: unknown) {
    const { POST } = await import("@/app/api/registry/versions/route");
    return POST(
      new Request("https://app.example/api/registry/versions", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      }),
    );
  }

  test("the publish workflow's upload is checked, countersigned, stored and audited", async () => {
    const archive = packTheme(readThemeDir("themes/editorial"));
    const response = await post(jwt(goodClaims), { archive: Buffer.from(archive).toString("base64"), scores: { about: { performance: 100 } }, attestation: attestation(dir, archive, IDENTITY) });
    assert.equal(response.status, 201, await response.clone().text());
    assert.deepEqual(await response.json(), { name: "@pagefirst/editorial", version: "1.0.0", integrity: archiveIntegrity(archive) });
    assert.equal((await latestVersion("@pagefirst/editorial"))!.integrity, archiveIntegrity(archive));
    const [row] = await query<{ provenance: { repository: string; runId: string; attestation: unknown } }>("SELECT provenance FROM theme_versions WHERE name = '@pagefirst/editorial'");
    assert.equal(row!.provenance.repository, "thegreenbot/pagefirst");
    assert.equal(row!.provenance.runId, "42");
    assert.ok(row!.provenance.attestation);
    const [audit] = await query<{ outcome: string; actor_sub: string }>("SELECT outcome, actor_sub FROM audit_events WHERE event = 'registry.publish' ORDER BY id DESC LIMIT 1");
    assert.deepEqual(audit, { outcome: "ok", actor_sub: "github:thegreenbot/pagefirst" });
  });

  test("no token is 401, a bad token is 401, a fork is 403, and nothing is stored", async () => {
    const archive = packTheme(readThemeDir("themes/default"));
    const body = { archive: Buffer.from(archive).toString("base64"), attestation: attestation(dir, archive, IDENTITY) };
    assert.equal((await post(null, body)).status, 401);
    assert.equal((await post(jwt({ ...goodClaims, aud: "x" }), body)).status, 401);
    const fork = await post(jwt({ ...goodClaims, repository: "someone/pagefirst" }), body);
    assert.equal(fork.status, 403);
    // The default theme's tag differs from the token's editorial tag, so the right repo is refused too.
    assert.equal((await post(jwt(goodClaims), body)).status, 403);
    assert.equal(await latestVersion("@pagefirst/default"), null);
  });

  test("an invalid archive is 422", async () => {
    const response = await post(jwt(goodClaims), { archive: Buffer.from("junk").toString("base64"), attestation: {} });
    assert.equal(response.status, 422);
  });
});
