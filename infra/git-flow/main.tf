locals {
  owner = "william-mccreery"
  repo  = "page-first"
}

resource "cursor_origin_repo_ruleset" "protect_main" {
  owner       = local.owner
  repo        = local.repo
  name        = "main: block direct pushes"
  description = "Refuse direct pushes, force-pushes, and deletion of main. Releases and hotfixes merge through pull requests."
  enforcement = "active"
  kind        = "push_branch"

  included_ref_names = ["refs/heads/main"]

  rule {
    block_direct_updates {}
  }

  rule {
    deletion {}
  }

  rule {
    non_fast_forward {}
  }
}

resource "cursor_origin_repo_ruleset" "main_pull_requests" {
  owner       = local.owner
  repo        = local.repo
  name        = "main: merge by pull request"
  description = "Changes reach main through a pull request."
  enforcement = "active"
  kind        = "merge_branch"

  included_ref_names = ["refs/heads/main"]

  rule {
    pull_request {
      required_approving_review_count = 0
    }
  }
}

resource "cursor_origin_repo_ruleset" "protect_develop" {
  owner       = local.owner
  repo        = local.repo
  name        = "develop: block direct pushes"
  description = "Refuse direct pushes, force-pushes, and deletion of develop. Features merge through pull requests."
  enforcement = "active"
  kind        = "push_branch"

  included_ref_names = ["refs/heads/develop"]

  rule {
    block_direct_updates {}
  }

  rule {
    deletion {}
  }

  rule {
    non_fast_forward {}
  }
}

resource "cursor_origin_repo_ruleset" "develop_pull_requests" {
  owner       = local.owner
  repo        = local.repo
  name        = "develop: merge by pull request"
  description = "Changes reach develop through a pull request."
  enforcement = "active"
  kind        = "merge_branch"

  included_ref_names = ["refs/heads/develop"]

  rule {
    pull_request {
      required_approving_review_count = 0
    }
  }
}

resource "cursor_platform_workflow" "pr_ci" {
  name        = "page-first PR CI"
  description = "Runs lint, unit tests, and npm audit when a pull request opens or gets new commits."
  scope       = "user"
  enabled     = true
  prompt      = file("${path.module}/../../automation/pr-ci-prompt.md")
  git_repo    = "origin.cursor.com/git/${local.owner}/${local.repo}"
  git_branch  = "develop"

  disabled_default_tools = ["open_git_pr"]

  trigger = [
    {
      git_pull_request = {
        repos            = ["${local.owner}/${local.repo}"]
        pr_action        = "opened"
        ignore_draft_prs = false
      }
    },
    {
      git_pull_request = {
        repos            = ["${local.owner}/${local.repo}"]
        pr_action        = "pushed"
        ignore_draft_prs = false
      }
    }
  ]

  action = [
    {
      pr_comment = {
        allow_inline_comments = false
        allow_approve         = false
      }
    },
    {
      manage_check_run = {}
    }
  ]
}
