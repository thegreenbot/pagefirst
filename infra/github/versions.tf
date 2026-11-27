terraform {
  required_version = ">= 1.5.0"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

# Authenticates with GITHUB_TOKEN: a fine-grained token for thegreenbot/pagefirst
# with Administration: read and write.
provider "github" {
  owner = var.owner
}
