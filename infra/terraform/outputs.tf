output "artifact_repository" {
  value = google_artifact_registry_repository.app.name
}

output "frontend_url" {
  value = google_cloud_run_v2_service.frontend.uri
}

output "worker_url" {
  value = google_cloud_run_v2_service.worker.uri
}

output "mcp_url" {
  value = "${var.public_base_url}/mcp"
}

output "oauth_callback_url" {
  value = "${var.public_base_url}/auth/google/callback"
}

output "secret_names" {
  description = "Add pinned secret versions to these containers before the full apply"
  value       = { for environment, secret in google_secret_manager_secret.app : environment => secret.secret_id }
}

output "kms_key_name" {
  value = google_kms_crypto_key.browser_state.id
}
