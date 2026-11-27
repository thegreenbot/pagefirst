# Theme registry

The registry (#64, [ADR 0002 section 13](../docs/adr/0002-theme-package-contract.md)) stores immutable theme versions in Postgres. Publishes verify each version's integrity and the registry's countersignature before rendering with it.

## Keys

The registry signs with an Ed25519 key pair.

1. Generate one:

   ```sh
   openssl genpkey -algorithm ed25519 -out registry.pem
   openssl pkey -in registry.pem -pubout -out registry.pub.pem
   ```

2. Set `THEME_REGISTRY_PUBLIC_KEYS` to the contents of `registry.pub.pem` wherever the app renders (every Vercel environment).
3. Set `THEME_REGISTRY_SIGNING_KEY` to the contents of `registry.pem` only where versions are published.
4. Delete the local files.

Without `THEME_REGISTRY_PUBLIC_KEYS`, no registry version verifies, so sites that lock to one fail to render. Sites on bundled themes are unaffected.

## Rotating the key

1. Generate a new pair.
2. Add the new public key to `THEME_REGISTRY_PUBLIC_KEYS`, comma-separated, and deploy.
3. Switch `THEME_REGISTRY_SIGNING_KEY` to the new private key.
4. Versions signed with the old key keep verifying while its public key stays listed. Remove it once nothing locks to those versions, or republish them under new version numbers.

## Publishing a version

Versions come only from `.github/workflows/theme-publish.yml`, run by pushing a release tag:

1. Bump `version` in `themes/<dir>/theme.json` and merge it.
2. Tag the merged commit `theme-<dir>-v<version>`, e.g. `git tag theme-editorial-v1.0.1 && git push origin theme-editorial-v1.0.1`.
3. The workflow then:
   1. runs the byte and Lighthouse budgets for that theme;
   2. packs the archive, refusing if `theme.json` disagrees with the tag;
   3. makes a Sigstore build-provenance attestation and verifies it with `gh attestation verify`;
   4. uploads the archive, scores and attestation with its GitHub OIDC token.
4. The registry (`POST /api/registry/versions`) checks:
   - the token's signature, issuer, audience (`pagefirst-theme-registry`), repository, tag and workflow file;
   - that the attestation was signed by this workflow for this exact archive.
   It then re-runs the byte budgets, countersigns, and stores the version. A version number can be used only once.

One-time setup:

- In GitHub, under **Settings, Environments**, create `theme-registry`. Add the variable `THEME_REGISTRY_URL`, the production app's URL, e.g. `https://app.example.com`. Adding required reviewers there makes each publish wait for an approval.
- On the production deployment, set `THEME_REGISTRY_SIGNING_KEY`. Only a deployment with that key accepts uploads; others answer 503.
- `THEME_REGISTRY_TRUSTED_REPOSITORY` defaults to `thegreenbot/pagefirst`; change it only if the repository moves.

## Yanking a version or flagging an advisory

A yanked version is never chosen for a new lock. Sites already locked to it keep rendering it until they change their theme or range.

```sql
UPDATE theme_versions SET yanked_at = now(), advisory = 'What is wrong and what to do'
WHERE name = '@pagefirst/default' AND version = '1.1.0';
```

No other column can change, and no row can be deleted: the `theme_versions_no_rewrite` trigger refuses.

## If verification fails in production

The publish error names the version and says whether the archive hash or the signature failed. Treat either as possible tampering:

1. Do not disable the check.
2. Compare the stored archive's hash with the CI artifact from the run that published it.
3. Follow [incident-response.md](incident-response.md).
