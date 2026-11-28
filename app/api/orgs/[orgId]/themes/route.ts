import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { planBlock, requireOrgAdmin } from "@/enterprise/admin";
import { readTextCapped } from "@/lib/http/body";
import { listOrgVersions, privateScope, publishVersion, RegistryError } from "@/lib/theme/registry-store";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string }> };

/** Same ceiling as the public registry: archives are at most 4 MB unpacked, base64 inside this. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The organization's private themes and the scope their names must use (#69). */
export async function GET(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "org-themes-read");
  if (admin instanceof NextResponse) return admin;
  const versions = await listOrgVersions(admin.orgId);
  return NextResponse.json({
    scope: `@${privateScope(admin.orgId)}`,
    versions: versions.map(({ name, version, integrity, description, publishedAt, yanked }) => ({ name, version, integrity, description, publishedAt, yanked })),
  });
}

/**
 * Uploads a private theme version: `{ archive: <base64 tarball> }`. The theme's
 * name must sit under the organization's scope, so a private theme can never
 * take a public name, and it is checked, budgeted and countersigned exactly like
 * a public one. Only the organization's own sites can list or install it.
 */
export async function POST(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "org-themes-upload");
  if (admin instanceof NextResponse) return admin;
  const blocked = await planBlock(admin.orgId, "themeGovernance");
  if (blocked) return blocked;
  if (!process.env.THEME_REGISTRY_SIGNING_KEY) return NextResponse.json({ error: "This deployment does not publish themes." }, { status: 503 });
  const read = await readTextCapped(request, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: "The upload is too large." }, { status: 413 });
  let body: { archive?: unknown };
  try {
    body = JSON.parse(read.text);
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }
  if (typeof body.archive !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.archive)) {
    return NextResponse.json({ error: "archive must be base64." }, { status: 400 });
  }
  const scope = `@${privateScope(admin.orgId)}/`;
  try {
    const published = await publishVersion(
      new Uint8Array(Buffer.from(body.archive, "base64")),
      { source: "org-upload", orgId: admin.orgId, uploadedBy: admin.sub },
      null,
      (manifest) => {
        if (!manifest.name.startsWith(scope)) throw new RegistryError(`Private theme names must start with ${scope}`);
      },
      admin.orgId,
    );
    await auditRequest(request, { event: "registry.publish", outcome: "ok", status: 201, actorSub: admin.sub, pagePath: `${admin.orgId}:${published.name}@${published.version}` });
    return NextResponse.json({ name: published.name, version: published.version, integrity: published.integrity }, { status: 201 });
  } catch (cause) {
    if (!(cause instanceof RegistryError)) throw cause;
    await auditRequest(request, { event: "registry.publish", outcome: "error", status: 422, errorCode: "invalid", actorSub: admin.sub, pagePath: admin.orgId });
    return NextResponse.json({ error: cause.message }, { status: 422 });
  }
}
