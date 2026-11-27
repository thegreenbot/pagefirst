output "app_url" {
  description = "Where the app will be served once DNS for app_domain points at Vercel."
  value       = local.app_url
}

output "google_redirect_uri" {
  description = "Register this exact redirect URI on the Google OAuth client."
  value       = "${local.app_url}/api/auth/callback"
}

output "app_dns" {
  description = "DNS record to create for app_domain (DNS-only, not proxied)."
  value       = "CNAME ${var.app_domain} -> cname.vercel-dns.com"
}

output "wrangler_config" {
  description = "Deploy the site-serving Worker with: npx wrangler deploy -c <this path>."
  value       = local_file.wrangler.filename
}

output "pagefirst_version" {
  value = var.pagefirst_version
}
