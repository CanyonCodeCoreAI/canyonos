# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

output "cluster_id" {
  value = module.rosa.cluster_id
}

output "api_url" {
  value = module.rosa.cluster_api_url
}

output "console_url" {
  value = module.rosa.cluster_console_url
}

output "admin_username" {
  value     = module.rosa.cluster_admin_username
  sensitive = true
}

output "admin_password" {
  value     = module.rosa.cluster_admin_password
  sensitive = true
}

# Only a VPC made for the cluster: teardown may clean up inside that one alone.
output "vpc_id" {
  value = local.new_network ? module.vpc[0].vpc_id : null
}
