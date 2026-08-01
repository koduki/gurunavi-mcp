locals {
  required_apis = toset([
    "artifactregistry.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudtasks.googleapis.com",
    "firestore.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
  ])

  secret_environment = {
    GOOGLE_OAUTH_CLIENT_ID     = "google-oauth-client-id"
    GOOGLE_OAUTH_CLIENT_SECRET = "google-oauth-client-secret"
    TOKEN_SIGNING_SECRET       = "token-signing-secret"
    SESSION_ENCRYPTION_KEY     = "session-encryption-key"
  }

  worker_secret_environment = {
    TOKEN_SIGNING_SECRET   = local.secret_environment["TOKEN_SIGNING_SECRET"]
    SESSION_ENCRYPTION_KEY = local.secret_environment["SESSION_ENCRYPTION_KEY"]
  }

  ttl_collections = toset([
    "gurunavi_mcp_reservations",
    "gurunavi_mcp_browser_sessions",
    "gurunavi_mcp_interactions",
    "gurunavi_mcp_oauth_requests",
    "gurunavi_mcp_oauth_codes",
  ])

  common_environment = {
    NODE_ENV                         = "production"
    PUBLIC_BASE_URL                  = var.public_base_url
    GURUNAVI_BASE_URL                = "https://r.gnavi.co.jp"
    BROWSER_WORKER_AUDIENCE          = "https://gurunavi-browser-worker.internal"
    BROWSER_INVOKER_EMAIL            = google_service_account.frontend.email
    FIRESTORE_DATABASE_ID            = "(default)"
    GOOGLE_CLOUD_PROJECT             = var.project_id
    KMS_KEY_NAME                     = google_kms_crypto_key.browser_state.id
    CLOUD_TASKS_QUEUE                = google_cloud_tasks_queue.reservation_status.name
    CLOUD_TASKS_LOCATION             = var.region
    TASKS_TARGET_URL                 = var.public_base_url
    TASKS_INVOKER_EMAIL              = google_service_account.tasks_invoker.email
    ALLOWED_EMAILS                   = join(",", [for email in var.allowed_emails : lower(email)])
    RESERVATION_SUBMIT_ENABLED       = tostring(var.enable_reservation_submit)
    AUTH_DISABLED                    = "false"
    INTERACTION_TOKEN_TTL_SECONDS    = "900"
    GURUNAVI_MIN_REQUEST_INTERVAL_MS = "2000"
    GURUNAVI_NAVIGATION_TIMEOUT_MS   = "30000"
    LOG_LEVEL                        = var.log_level
  }

  frontend_environment = merge(local.common_environment, {
    SERVICE_MODE                 = "mcp"
    BROWSER_WORKER_URL           = google_cloud_run_v2_service.worker.uri
    BROWSER_INTERACTION_BASE_URL = google_cloud_run_v2_service.worker.uri
  })

  worker_environment = merge(local.common_environment, {
    SERVICE_MODE                 = "worker"
    BROWSER_WORKER_URL           = ""
    BROWSER_INTERACTION_BASE_URL = var.public_base_url
  })
}

resource "google_project_service" "required" {
  for_each = local.required_apis

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "app" {
  project       = var.project_id
  location      = var.region
  repository_id = "${var.name_prefix}-mcp"
  description   = "Container images for the Gurunavi MCP"
  format        = "DOCKER"

  depends_on = [google_project_service.required["artifactregistry.googleapis.com"]]
}

resource "google_firestore_database" "default" {
  count = var.create_firestore_database ? 1 : 0

  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  deletion_policy = "ABANDON"

  depends_on = [google_project_service.required["firestore.googleapis.com"]]
}

resource "google_firestore_field" "ttl" {
  for_each = local.ttl_collections

  project    = var.project_id
  database   = "(default)"
  collection = each.value
  field      = "expiresAt"

  ttl_config {}

  depends_on = [google_project_service.required["firestore.googleapis.com"]]
}

resource "google_kms_key_ring" "app" {
  project  = var.project_id
  name     = "${var.name_prefix}-mcp"
  location = var.region

  depends_on = [google_project_service.required["cloudkms.googleapis.com"]]
}

resource "google_kms_crypto_key" "browser_state" {
  name            = "browser-session-state"
  key_ring        = google_kms_key_ring.app.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s"

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret" "app" {
  for_each = local.secret_environment

  project   = var.project_id
  secret_id = "${var.name_prefix}-${each.value}"

  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required["secretmanager.googleapis.com"]]
}

resource "google_service_account" "frontend" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-mcp"
  display_name = "Gurunavi MCP frontend"
}

resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-browser"
  display_name = "Gurunavi dedicated browser worker"
}

resource "google_service_account" "tasks_invoker" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-tasks"
  display_name = "Gurunavi reservation status task invoker"
}

resource "google_project_iam_member" "firestore_frontend" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.frontend.email}"
}

resource "google_project_iam_member" "firestore_worker" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_kms_crypto_key_iam_member" "worker" {
  crypto_key_id = google_kms_crypto_key.browser_state.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "frontend" {
  for_each = google_secret_manager_secret.app

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.frontend.email}"
}

resource "google_secret_manager_secret_iam_member" "worker" {
  for_each = local.worker_secret_environment

  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_cloud_tasks_queue" "reservation_status" {
  project  = var.project_id
  name     = "${var.name_prefix}-reservation-status"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 1
    max_concurrent_dispatches = 2
  }

  retry_config {
    max_attempts       = 10
    max_retry_duration = "3600s"
    min_backoff        = "10s"
    max_backoff        = "300s"
    max_doublings      = 4
  }

  stackdriver_logging_config {
    sampling_ratio = 1
  }

  depends_on = [google_project_service.required["cloudtasks.googleapis.com"]]
}

resource "google_cloud_tasks_queue_iam_member" "frontend" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.reservation_status.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.frontend.email}"
}

data "google_project" "current" {
  project_id = var.project_id
}

resource "google_service_account_iam_member" "tasks_oidc" {
  service_account_id = google_service_account.tasks_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"

  depends_on = [google_project_service.required["cloudtasks.googleapis.com"]]
}

resource "google_cloud_run_v2_service" "worker" {
  project             = var.project_id
  name                = "${var.name_prefix}-browser"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  template {
    service_account                  = google_service_account.worker.email
    timeout                          = "3600s"
    max_instance_request_concurrency = 1
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_max_instances
    }

    containers {
      image = var.container_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        initial_delay_seconds = 2
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 24
        http_get {
          path = "/readyz"
          port = 8080
        }
      }

      liveness_probe {
        timeout_seconds   = 3
        period_seconds    = 30
        failure_threshold = 3
        http_get {
          path = "/healthz"
          port = 8080
        }
      }

      dynamic "env" {
        for_each = local.worker_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.worker_secret_environment
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.key].secret_id
              version = var.secret_version
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.required["run.googleapis.com"],
    google_secret_manager_secret_iam_member.worker,
    google_kms_crypto_key_iam_member.worker,
  ]
}

resource "google_cloud_run_v2_service" "frontend" {
  project             = var.project_id
  name                = "${var.name_prefix}-mcp"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  template {
    service_account                  = google_service_account.frontend.email
    timeout                          = "300s"
    max_instance_request_concurrency = 40
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = var.frontend_min_instances
      max_instance_count = var.frontend_max_instances
    }

    containers {
      image = var.container_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        initial_delay_seconds = 1
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 12
        http_get {
          path = "/readyz"
          port = 8080
        }
      }

      liveness_probe {
        timeout_seconds   = 3
        period_seconds    = 30
        failure_threshold = 3
        http_get {
          path = "/healthz"
          port = 8080
        }
      }

      dynamic "env" {
        for_each = local.frontend_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_environment
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.key].secret_id
              version = var.secret_version
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.required["run.googleapis.com"],
    google_secret_manager_secret_iam_member.frontend,
    google_cloud_tasks_queue_iam_member.frontend,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "worker_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "frontend_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.frontend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
