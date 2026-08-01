variable "project_id" {
  description = "GCP project ID"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid 6-30 character GCP project ID."
  }
}

variable "region" {
  description = "Region for Cloud Run, KMS, Artifact Registry, and Cloud Tasks"
  type        = string
  default     = "asia-northeast1"
}

variable "name_prefix" {
  description = "Prefix used for all managed resources"
  type        = string
  default     = "gurunavi"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 3-22 lowercase letters, digits, or hyphens."
  }
}

variable "container_image" {
  description = "Immutable container image URL, preferably pinned by digest"
  type        = string

  validation {
    condition     = length(trimspace(var.container_image)) > 0
    error_message = "container_image must not be empty."
  }
}

variable "public_base_url" {
  description = "Stable HTTPS origin exposed to MCP/OAuth clients (Cloud Run URL or custom domain)"
  type        = string

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(?::[0-9]+)?$", var.public_base_url))
    error_message = "public_base_url must be an HTTPS origin without a path, query, fragment, or trailing slash."
  }
}

variable "allowed_emails" {
  description = "Google account emails allowed to authorize this single-user MCP"
  type        = list(string)

  validation {
    condition = (
      length(var.allowed_emails) > 0 &&
      alltrue([
        for email in var.allowed_emails :
        can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", email))
      ])
    )
    error_message = "At least one syntactically valid allowed email is required."
  }
}

variable "secret_version" {
  description = "Pinned Secret Manager version used by Cloud Run; create this version before the full apply"
  type        = string
  default     = "1"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.secret_version))
    error_message = "secret_version must be a pinned numeric Secret Manager version."
  }
}

variable "create_firestore_database" {
  description = "Create the default Firestore Native database. Disable if it already exists."
  type        = bool
  default     = false
}

variable "firestore_location" {
  description = "Firestore database location when create_firestore_database is true"
  type        = string
  default     = "asia-northeast1"
}

variable "enable_reservation_submit" {
  description = "Enable real reservation and cancellation mutations"
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protect Cloud Run services from Terraform deletion"
  type        = bool
  default     = true
}

variable "frontend_min_instances" {
  type    = number
  default = 0

  validation {
    condition     = var.frontend_min_instances >= 0
    error_message = "frontend_min_instances must be non-negative."
  }
}

variable "frontend_max_instances" {
  type    = number
  default = 3

  validation {
    condition     = var.frontend_max_instances >= 1
    error_message = "frontend_max_instances must be at least 1."
  }
}

variable "worker_min_instances" {
  type    = number
  default = 0

  validation {
    condition     = var.worker_min_instances >= 0
    error_message = "worker_min_instances must be non-negative."
  }
}

variable "worker_max_instances" {
  type    = number
  default = 2

  validation {
    condition     = var.worker_max_instances >= 1
    error_message = "worker_max_instances must be at least 1."
  }
}

variable "log_level" {
  type    = string
  default = "info"

  validation {
    condition     = contains(["error", "warn", "info", "debug"], var.log_level)
    error_message = "log_level must be error, warn, info, or debug."
  }
}
