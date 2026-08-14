## WatchMyGate infrastructure — Google Cloud, asia-southeast1 (Singapore).
##
## Region rationale: Neon has no India region, so compute is co-located with the
## database in Singapore. Splitting them (Cloud Run in Mumbai, Neon in Singapore)
## would put every query across the sea — see design/ARCHITECTURE.md.
##
## Neon itself is not managed here; it is provisioned in the Neon console and its
## connection string stored in Secret Manager.

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type        = string
  description = "Google Cloud project id"
}

variable "region" {
  type        = string
  default     = "asia-southeast1"
  description = "Co-located with Neon. Do not change without moving the database."
}

variable "api_image" {
  type        = string
  description = "Container image for the API service"
}

variable "worker_image" {
  type        = string
  description = "Container image for the worker service"
}

locals {
  services = [
    "run.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)
  service  = each.value

  disable_on_destroy = false
}

## ---------------------------------------------------------------- identities

resource "google_service_account" "api" {
  account_id   = "watchmygate-api"
  display_name = "WatchMyGate API"
}

resource "google_service_account" "worker" {
  account_id   = "watchmygate-worker"
  display_name = "WatchMyGate Worker"
}

## ------------------------------------------------------------------ secrets
## Values are never in Terraform state — create the secret, add versions manually
## or through CI with a deploy identity.

resource "google_secret_manager_secret" "app" {
  for_each = toset([
    "database-url",
    "jwt-secret",
    "msg91-auth-key",
    "razorpay-key-secret",
    "razorpay-webhook-secret",
    "r2-secret-access-key",
    "anthropic-api-key",
    "exotel-token",
  ])

  secret_id = each.value
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "api_access" {
  for_each = google_secret_manager_secret.app

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_access" {
  for_each = google_secret_manager_secret.app

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

## ---------------------------------------------------------------- API service
## min_instance_count = 2 is not an optimisation. Scale-to-zero would make the first
## gate entry each morning wait for a cold start, against an 800 ms p95 budget.

resource "google_cloud_run_v2_service" "api" {
  name     = "watchmygate-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = 2
      max_instance_count = 100
    }

    containers {
      image = var.api_image

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle = false # keep CPU allocated so warm instances stay warm
      }

      env {
        name  = "ENVIRONMENT"
        value = "production"
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }

      dynamic "env" {
        for_each = {
          DATABASE_URL            = "database-url"
          JWT_SECRET              = "jwt-secret"
          MSG91_AUTH_KEY          = "msg91-auth-key"
          RAZORPAY_KEY_SECRET     = "razorpay-key-secret"
          RAZORPAY_WEBHOOK_SECRET = "razorpay-webhook-secret"
          R2_SECRET_ACCESS_KEY    = "r2-secret-access-key"
          ANTHROPIC_API_KEY       = "anthropic-api-key"
          EXOTEL_TOKEN            = "exotel-token"
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get { path = "/healthz" }
        initial_delay_seconds = 3
        period_seconds        = 3
        failure_threshold     = 10
      }

      liveness_probe {
        http_get { path = "/healthz" }
        period_seconds = 30
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

## -------------------------------------------------------------- worker service
## Scales to zero — invoked by Cloud Tasks and Cloud Scheduler, not by users.

resource "google_cloud_run_v2_service" "worker" {
  name     = "watchmygate-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.worker.email

    scaling {
      min_instance_count = 0
      max_instance_count = 50
    }

    containers {
      image = var.worker_image
      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
      env {
        name  = "ENVIRONMENT"
        value = "production"
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

## ------------------------------------------------------------------- queues
## The approval ladder relies on scheduled delivery: one task per rung, enqueued at
## creation and cancelled if the resident responds first.

resource "google_cloud_tasks_queue" "approval_ladder" {
  name     = "approval-ladder"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 500
    max_concurrent_dispatches = 1000
  }

  retry_config {
    max_attempts       = 5
    min_backoff        = "1s"
    max_backoff        = "30s"
    max_retry_duration = "300s"
  }

  depends_on = [google_project_service.enabled]
}

resource "google_cloud_tasks_queue" "notifications" {
  name     = "notifications"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 200
    max_concurrent_dispatches = 500
  }

  retry_config {
    max_attempts = 10
    min_backoff  = "5s"
    max_backoff  = "600s"
  }

  depends_on = [google_project_service.enabled]
}

## ---------------------------------------------------------------- schedulers

resource "google_cloud_scheduler_job" "monthly_billing" {
  name      = "monthly-billing-run"
  region    = var.region
  schedule  = "0 2 1 * *" # 02:00 on the 1st
  time_zone = "Asia/Kolkata"

  http_target {
    uri         = "${google_cloud_run_v2_service.worker.uri}/jobs/billing-run"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.worker.email
    }
  }
}

resource "google_cloud_scheduler_job" "sla_sweep" {
  name      = "helpdesk-sla-sweep"
  region    = var.region
  schedule  = "*/15 * * * *"
  time_zone = "Asia/Kolkata"

  http_target {
    uri         = "${google_cloud_run_v2_service.worker.uri}/jobs/sla-sweep"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.worker.email
    }
  }
}

resource "google_cloud_scheduler_job" "ledger_invariants" {
  name      = "ledger-invariant-check"
  region    = var.region
  schedule  = "0 * * * *"
  time_zone = "Asia/Kolkata"

  http_target {
    uri         = "${google_cloud_run_v2_service.worker.uri}/jobs/ledger-invariants"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.worker.email
    }
  }
}

output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "worker_url" {
  value = google_cloud_run_v2_service.worker.uri
}
