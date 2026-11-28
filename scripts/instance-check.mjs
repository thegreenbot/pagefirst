// Checks an instance config file against the same rules infra/instance/variables.tf enforces,
// so mistakes show up before `terraform plan`. Usage: node scripts/instance-check.mjs [file]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const host = /^([a-z0-9-]+\.)+[a-z]{2,}$/;
const hex32 = /^[0-9a-f]{32}$/;

export const REQUIRED = [
  "name", "app_domain", "publish_domain", "cloudflare_account_id", "cloudflare_zone_id",
  "git_repository", "pagefirst_version", "google_client_id",
];
const SECRETS = ["google_client_secret", "r2_api_token"];
const KNOWN = new Set([
  ...REQUIRED, ...SECRETS, "r2_location", "vercel_team", "git_ref", "neon_region",
  "neon_pg_version", "audit_admin_emails",
]);

/** Returns a list of problems; empty means the config is valid. */
export function checkInstance(config) {
  const errors = [];
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return ["config must be a JSON object"];
  }
  for (const key of REQUIRED) {
    if (typeof config[key] !== "string" || config[key] === "") errors.push(`${key} is required`);
  }
  for (const key of SECRETS) {
    if (key in config) errors.push(`${key} is a secret: pass it as TF_VAR_${key}, not in the file`);
  }
  for (const key of Object.keys(config)) {
    if (!KNOWN.has(key)) errors.push(`unknown setting ${key}`);
  }
  const is = (key, re) => typeof config[key] === "string" && re.test(config[key]);
  if (config.name && !is("name", /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/)) errors.push("name must be 3-32 lowercase letters, digits or hyphens, starting with a letter");
  if (config.app_domain && !is("app_domain", host)) errors.push("app_domain must be a lowercase hostname");
  if (config.publish_domain && !is("publish_domain", host)) errors.push("publish_domain must be a lowercase domain");
  if (is("app_domain", host) && config.app_domain === config.publish_domain) {
    errors.push("app_domain and publish_domain must differ: the app hostname must not pass through the sites Worker");
  }
  if (config.cloudflare_account_id && !is("cloudflare_account_id", hex32)) errors.push("cloudflare_account_id must be 32 hex characters");
  if (config.cloudflare_zone_id && !is("cloudflare_zone_id", hex32)) errors.push("cloudflare_zone_id must be 32 hex characters");
  if (config.git_repository && !is("git_repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)) errors.push("git_repository must look like owner/name");
  if (config.pagefirst_version && !is("pagefirst_version", /^v\d+\.\d+\.\d+$/)) errors.push("pagefirst_version must look like v1.2.3");
  if (config.git_ref === "develop") errors.push("git_ref must be a release branch, never develop");
  if (config.google_client_id && !is("google_client_id", /\.apps\.googleusercontent\.com$/)) errors.push("google_client_id must end in .apps.googleusercontent.com");
  if ("r2_location" in config && !["wnam", "enam", "weur", "eeur", "apac"].includes(config.r2_location)) errors.push("r2_location must be one of wnam, enam, weur, eeur, apac");
  if ("audit_admin_emails" in config && !(Array.isArray(config.audit_admin_emails) && config.audit_admin_emails.every((e) => typeof e === "string" && e.includes("@")))) {
    errors.push("audit_admin_emails must be a list of email addresses");
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? "infra/instance/instance.auto.tfvars.json";
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Cannot read ${file}: ${error.message}`);
    process.exit(2);
  }
  const errors = checkInstance(config);
  for (const e of errors) console.error(`- ${e}`);
  if (errors.length) process.exit(1);
  console.log(`${file} is valid`);
}
