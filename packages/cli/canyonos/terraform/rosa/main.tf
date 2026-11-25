# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# A ROSA cluster with hosted control planes in a VPC of its own, from Red Hat's module,
# with a cluster-admin user `canyonos provision` signs in with. The Red Hat credentials
# come from RHCS_TOKEN, or RHCS_CLIENT_ID and RHCS_CLIENT_SECRET.

provider "aws" {
  region = var.region

  # Every resource, also those Red Hat's modules leave untagged (the VPC's S3 endpoint):
  # an account may refuse to make untagged ones.
  default_tags {
    tags = var.tags
  }
}

provider "rhcs" {}

locals {
  # No subnets given: the cluster gets a VPC of its own, deleted with it.
  new_network = length(var.subnet_ids) == 0
  # No OIDC configuration given: the cluster gets one of its own, deleted with it.
  new_oidc = var.oidc_config_id == ""
}

module "vpc" {
  source  = "terraform-redhat/rosa-hcp/rhcs//modules/vpc"
  version = "1.7.7"
  count   = local.new_network ? 1 : 0

  name_prefix              = var.cluster_name
  availability_zones_count = var.availability_zones
  tags                     = var.tags
}

module "rosa" {
  source  = "terraform-redhat/rosa-hcp/rhcs"
  version = "1.7.7"

  cluster_name      = var.cluster_name
  openshift_version = var.openshift_version
  machine_cidr      = local.new_network ? module.vpc[0].cidr_block : var.machine_cidr
  aws_subnet_ids = (
    local.new_network
    ? concat(module.vpc[0].public_subnets, module.vpc[0].private_subnets)
    : var.subnet_ids
  )
  # Given subnets: the zones they are in.
  aws_availability_zones = local.new_network ? module.vpc[0].availability_zones : []
  replicas               = var.workers
  compute_machine_type   = var.machine_type
  create_admin_user      = true
  tags                   = var.tags

  create_account_roles  = var.account_role_prefix == null
  account_role_prefix   = var.account_role_prefix
  create_oidc           = local.new_oidc
  oidc_config_id        = local.new_oidc ? null : var.oidc_config_id
  oidc_endpoint_url     = local.new_oidc ? null : var.oidc_endpoint_url
  create_operator_roles = true
  operator_role_prefix  = var.cluster_name
  path                  = var.role_path
  permissions_boundary  = var.permissions_boundary
}
