// Git-flow names shared by the push hook and the Origin ruleset installer.

const version = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";

export const branchBody = `(?:(?:feature|cursor)/[a-z0-9]+(?:[._/-][a-z0-9]+)*|(?:release|hotfix)/v${version})`;
export const tagBody = `v${version}`;

export const branchName = new RegExp(`^${branchBody}$`);
export const branchRef = new RegExp(`^(?:refs/heads/)?${branchBody}$`);
export const tagName = new RegExp(`^${tagBody}$`);
export const tagRef = new RegExp(`^(?:refs/tags/)?${tagBody}$`);

const ZERO_SHA = /^0+$/;

export function checkPushLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return { ok: true };
  const [, localSha, remoteRef, remoteSha] = parts;
  const deleting = ZERO_SHA.test(localSha);
  const creating = ZERO_SHA.test(remoteSha);

  if (remoteRef === "refs/heads/main") {
    return {
      ok: false,
      message:
        "refusing a direct update of main. Open a pull request from release/vX.Y.Z or hotfix/vX.Y.Z.",
    };
  }
  if (remoteRef === "refs/heads/develop") {
    return {
      ok: false,
      message:
        "refusing a direct update of develop. Open a pull request from a feature/<name> or cursor/<name> branch.",
    };
  }
  if (remoteRef.startsWith("refs/heads/")) {
    if (deleting) return { ok: true };
    const name = remoteRef.slice("refs/heads/".length);
    if (branchName.test(name)) return { ok: true };
    return {
      ok: false,
      message: `refusing branch ${name}. Use feature/<name>, cursor/<name>, release/vX.Y.Z, or hotfix/vX.Y.Z.`,
    };
  }
  if (remoteRef.startsWith("refs/tags/")) {
    const name = remoteRef.slice("refs/tags/".length);
    if (deleting || !creating) {
      return { ok: false, message: `refusing to move or delete tag ${name}.` };
    }
    if (tagName.test(name)) return { ok: true };
    return { ok: false, message: `refusing tag ${name}. Tags are vX.Y.Z semver.` };
  }
  return { ok: true };
}
