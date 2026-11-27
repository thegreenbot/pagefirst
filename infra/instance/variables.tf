# The instance config file. Copy instance.example.json to instance.auto.tfvars.json,
# edit it, and Terraform reads it with no flags. Secrets are not in this file:
# pass them as TF_VAR_google_client_secret etc.

variable "name" {
  description = "Short lowercase name of this instance. Prefixes every resource it creates."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name must be 3-32 characters: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "app_domain" {
  description = "Hostname the app is served from, such as pagefirst.example.com."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.app_domain))
    error_message = "app_domain must be a lowercase hostname."
  }
}

variable "publish_domain" {
  description = "Domain published sites are served under, one subdomain per site. It must be a zone in the Cloudflare account. It can equal app_domain's parent, but the app hostname itself must stay DNS-only."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.publish_domain))
    error_message = "publish_domain must be a lowercase domain."
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the R2 bucket, Worker and publish zone."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be 32 hex characters."
  }
}

variable "cloudflare_zone_id" {
  description = "Id of the Cloudflare zone for publish_domain."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be 32 hex characters."
  }
}

variable "r2_location" {
  description = "R2 location hint: wnam, enam, weur, eeur or apac."
  type        = string
  default     = "enam"
  validation {
    condition     = contains(["wnam", "enam", "weur", "eeur", "apac"], var.r2_location)
    error_message = "r2_location must be one of wnam, enam, weur, eeur, apac."
  }
}

variable "vercel_team" {
  description = "Vercel team slug or id that owns the project. Leave null for a personal account."
  type        = string
  default     = null
}

variable "git_repository" {
  description = "GitHub repository (owner/name) Vercel deploys: your fork of Pagefirst."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.git_repository))
    error_message = "git_repository must look like owner/name."
  }
}

variable "git_ref" {
  description = "Branch Vercel deploys to production. Pin it to a release branch or tag-tracking branch, never develop."
  type        = string
  default     = "main"
}

variable "pagefirst_version" {
  description = "Release you intend to run, such as v0.2.0. Recorded as an environment variable and in outputs; the upgrade runbook explains how to move it."
  type        = string
  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+$", var.pagefirst_version))
    error_message = "pagefirst_version must look like v1.2.3."
  }
}

variable "neon_region" {
  description = "Neon region id for the database, such as aws-us-east-2."
  type        = string
  default     = "aws-us-east-2"
}

variable "neon_pg_version" {
  description = "Postgres major version."
  type        = number
  default     = 17
}

variable "google_client_id" {
  description = "OAuth client id. For a dedicated instance, create the client in the customer's own Google Cloud project: an internal Workspace app needs no Google verification and has its own Docs API quota."
  type        = string
  validation {
    condition     = can(regex("\\.apps\\.googleusercontent\\.com$", var.google_client_id))
    error_message = "google_client_id must end in .apps.googleusercontent.com."
  }
}

variable "google_client_secret" {
  description = "OAuth client secret. Pass as TF_VAR_google_client_secret, not in the config file."
  type        = string
  sensitive   = true
}

variable "r2_api_token" {
  description = "Cloudflare API token limited to Object Read & Write on this instance's bucket (runbooks/site-publishing.md step 3). Pass as TF_VAR_r2_api_token."
  type        = string
  sensitive   = true
}

variable "audit_admin_emails" {
  description = "Google emails allowed to export every account's audit events."
  type        = list(string)
  default     = []
}
