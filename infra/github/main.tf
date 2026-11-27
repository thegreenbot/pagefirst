locals {
  # GitHub Actions' app id, so a check only counts when Actions reports it.
  github_actions_app_id = 15368
  # Built-in repository role id for Admin.
  admin_role_id = 5
}

# Pull requests only, required checks, no force pushes or deletion, and no
# bypass list. Required approvals is 0 because the repository has one
# maintainer, and GitHub never lets an author approve their own pull request.
resource "github_repository_ruleset" "branches" {
  name        = "main and develop"
  repository  = var.repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/main", "refs/heads/develop"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true

    pull_request {
      required_approving_review_count   = 0
      dismiss_stale_reviews_on_push     = false
      require_code_owner_review         = false
      require_last_push_approval        = false
      required_review_thread_resolution = true
    }

    required_status_checks {
      strict_required_status_checks_policy = false

      dynamic "required_check" {
        for_each = var.required_checks
        content {
          context        = required_check.value
          integration_id = local.github_actions_app_id
        }
      }
    }
  }
}

# Release tags (vX.Y.Z) are created by the maintainer when a release or hotfix
# merges into main, and are never moved or deleted.
resource "github_repository_ruleset" "release_tags" {
  name        = "release tags"
  repository  = var.repository
  target      = "tag"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/tags/v*"]
      exclude = []
    }
  }

  bypass_actors {
    actor_id    = local.admin_role_id
    actor_type  = "RepositoryRole"
    bypass_mode = "always"
  }

  rules {
    creation         = true
    update           = true
    deletion         = true
    non_fast_forward = true
  }
}
