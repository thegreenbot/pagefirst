terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cursor = {
      source  = "cursor/cursor"
      version = "~> 0.1"
    }
  }
}

provider "cursor" {}
