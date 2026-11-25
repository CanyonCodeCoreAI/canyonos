# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

variable "cluster_name" {
  type        = string
  description = "The cluster's name; also the prefix of its VPC and its operator roles."
}

variable "region" {
  type = string
}

variable "openshift_version" {
  type        = string
  description = "e.g. 4.20.5: a ROSA HCP version, 4.20 or later."
}

variable "availability_zones" {
  type        = number
  default     = 1
  description = "Zones the VPC and the workers span: 1 to try it out, 3 for high availability."
}

variable "workers" {
  type        = number
  default     = 2
  description = "Worker machines: 2 or more, a multiple of availability_zones."
}

variable "machine_type" {
  type    = string
  default = "m5.xlarge"
}

variable "account_role_prefix" {
  type        = string
  default     = null
  description = "The prefix of existing ROSA HCP account roles to reuse. Null: make this cluster its own, named <cluster_name>-account-*."
}

variable "role_path" {
  type    = string
  default = "/"
}

variable "permissions_boundary" {
  type        = string
  default     = ""
  description = "The ARN of the policy your account requires as the permissions boundary of every IAM role; empty for none."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags on everything made in AWS, besides the ones CanyonOS adds."
}

variable "subnet_ids" {
  type        = list(string)
  default     = []
  description = "Existing subnets to make the cluster in: a private one in each of its zones, and a public one in each for a public cluster. Empty: a new VPC of its own."
}

variable "machine_cidr" {
  type        = string
  default     = ""
  description = "The CIDR of the VPC the subnet_ids are in. Only with subnet_ids."
}

variable "oidc_config_id" {
  type        = string
  default     = ""
  description = "An existing, reusable Red Hat OIDC configuration to use. Empty: a new one of its own."
}

variable "oidc_endpoint_url" {
  type        = string
  default     = ""
  description = "The issuer URL of oidc_config_id. Only with oidc_config_id."
}
