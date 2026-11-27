variable "owner" {
  description = "GitHub owner of the repository."
  type        = string
  default     = "thegreenbot"
}

variable "repository" {
  description = "Repository name."
  type        = string
  default     = "pagefirst"
}

variable "required_checks" {
  description = <<-EOT
    Status checks every pull request into main or develop must pass. Each name
    is a job name (or `name:`) from .github/workflows/, so renaming a job means
    updating this list in the same pull request.
  EOT
  type = list(string)
  default = [
    "lint",                            # ci.yml
    "typecheck",                       # ci.yml
    "test",                            # ci.yml
    "audit",                           # ci.yml
    "build",                           # ci.yml
    "integration",                     # ci.yml
    "dependency-review",               # dependency-review.yml
    "gitleaks",                        # secret-scan.yml
    "analyze (javascript-typescript)", # codeql.yml
    "pr-source",                       # branch-policy.yml
  ]
}
