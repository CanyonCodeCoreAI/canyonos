# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The Red Hat OpenShift Service on AWS (ROSA) provisioner of `canyonos provision`: sign in
to AWS and Red Hat, choose the cluster's version, size and the rules your AWS account
sets for IAM roles and tags, then make a ROSA cluster with hosted control planes in a
VPC of its own, sign kubectl in to it and install CanyonOS.

`RosaPlatform` is its `cluster_provision.Platform`: Part A (`sign_in`, `ask`) asks in
menus and gives `RosaAccounts` and `RosaSettings`; Part B (`cluster_provision.make`)
makes the cluster from them without asking, so other callers can fill in a
`RosaSettings` themselves. Terraform makes it from the `rosa` module this CLI ships (Red
Hat's rosa-hcp module): the VPC, the cluster's OIDC configuration and operator roles,
account roles when the account has none to reuse, and the cluster. Tearing it down
removes all of it, with the workflows on it.
"""

import base64
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, replace
from typing import Any

from canyonos import cluster_provision, ui
from canyonos.aws_account import (
    STS_REGION,
    choose_boundary,
    PRIVATE_ELB_TAG,
    PUBLIC_ELB_TAG,
    choose_region,
    choose_tags,
    network_room,
    networks,
    refused,
    sign_in,
    terraform_environment,
)
from canyonos.aws_account import errors as aws_errors
from canyonos.cluster_provision import (
    Accounts,
    ClusterSettings,
    Platform,
    choose_install,
)
from canyonos.kubernetes_target import kubectl, sign_in_as_admin_account
from canyonos.os_support import write_private_file
from canyonos.provision import PROVISION_ID_TAG, ask, pick

PLATFORM = "rosa"
SSO_URL = (
    "https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token"
)
OCM_URL = "https://api.openshift.com"
TOKEN_PAGE = "https://console.redhat.com/openshift/token"
SERVICE_ACCOUNTS_PAGE = "https://console.redhat.com/iam/service-accounts"
# The oldest OpenShift the CanyonOS chart installs on (its BuildKit needs the
# nested-container SCC).
MIN_OPENSHIFT = (4, 20)
VERSIONS_SHOWN = 4
DEFAULT_NAME = "rosa-canyonos"
# A cluster name as ROSA takes it.
NAME_PATTERN = re.compile(r"^[a-z][-a-z0-9]{0,52}[a-z0-9]$")
# The prefix `rosa create account-roles` names its roles with.
DEFAULT_ACCOUNT_ROLE_PREFIX = "ManagedOpenShift"
MACHINE_TYPES = (
    ("m5.xlarge", "4 vCPU, 16 GiB memory. A good default."),
    ("m6i.xlarge", "4 vCPU, 16 GiB memory, a newer generation."),
    ("m5.2xlarge", "8 vCPU, 32 GiB memory, for bigger workflows."),
)
# Availability Zones the VPC and the workers span (the control plane is Red Hat's,
# across zones either way).
ZONES = (
    (1, "1 zone", "Cheapest. Enough to try CanyonOS out."),
    (
        3,
        "3 zones",
        "Workers keep running if one data center fails. More machines and network, "
        "so it costs more.",
    ),
)
# ROSA spreads workers evenly over the zones and needs at least 2 of them.
MIN_WORKERS = 2
ANOTHER_NUMBER = "__another_number__"
NEW = "__new__"
# The cluster-admin user's sign-in may be refused for a few minutes after the cluster
# is ready, while its identity provider starts.
SIGN_IN_SECONDS = 900
SIGN_IN_RETRY_SECONDS = 15
REQUEST_TIMEOUT_SECONDS = 30
PASSWORD_FILE = "admin-password"

OFFLINE_TOKEN = "__offline_token__"
SERVICE_ACCOUNT = "__service_account__"


class RedHat:
    """Red Hat's OpenShift Cluster Manager, signed in with an offline token or a service
    account: what Terraform's rhcs provider signs in with too."""

    def __init__(self, env_vars):
        self.env = env_vars
        self.token = self._access_token()

    def _access_token(self):
        if "RHCS_TOKEN" in self.env:
            form = {
                "grant_type": "refresh_token",
                "client_id": "cloud-services",
                "refresh_token": self.env["RHCS_TOKEN"],
            }
        else:
            form = {
                "grant_type": "client_credentials",
                "client_id": self.env["RHCS_CLIENT_ID"],
                "client_secret": self.env["RHCS_CLIENT_SECRET"],
            }
        request = urllib.request.Request(
            SSO_URL, data=urllib.parse.urlencode(form).encode(), method="POST"
        )
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as reply:
            return json.load(reply)["access_token"]

    def get(self, path, **params):
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        request = urllib.request.Request(
            f"{OCM_URL}{path}{query}", headers={"Authorization": f"Bearer {self.token}"}
        )
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as reply:
            return json.load(reply)

    def versions(self):
        """The ROSA HCP versions on the stable channel CanyonOS runs on, newest first:
        the latest patch of each minor version."""
        found = self.get(
            "/api/clusters_mgmt/v1/versions",
            search="enabled='t' and rosa_enabled='t' and "
            "hosted_control_plane_enabled='t' and channel_group='stable'",
            size=500,
        )
        newest = {}
        for item in found.get("items", []):
            raw = item.get("raw_id", "")
            if not re.fullmatch(r"\d+\.\d+\.\d+", raw):
                continue
            version = tuple(int(part) for part in raw.split("."))
            if version[:2] >= MIN_OPENSHIFT and version > newest.get(version[:2], ()):
                newest[version[:2]] = version
        return [".".join(map(str, v)) for v in sorted(newest.values(), reverse=True)]

    def oidc_configs(self):
        """Red Hat's OIDC configurations of this organization that clusters may share
        (managed by Red Hat and reusable): [{id, issuer_url, created}]."""
        found = self.get("/api/clusters_mgmt/v1/oidc_configs", size=100)
        return [
            {
                "id": item["id"],
                "issuer_url": item.get("issuer_url", ""),
                "created": item.get("creation_timestamp", "")[:10],
            }
            for item in found.get("items", [])
            if item.get("managed") and item.get("reusable", True)
        ]

    def linked_roles(self, account):
        """Whether Red Hat has an OCM role and a user role linked in AWS account
        `account`, which it needs to make clusters there: (ocm_role, user_role)."""
        me = self.get("/api/accounts_mgmt/v1/current_account")
        labels = {
            label["key"]: label["value"]
            for path in (
                f"/api/accounts_mgmt/v1/organizations/{me['organization']['id']}/labels",
                f"/api/accounts_mgmt/v1/accounts/{me['id']}/labels",
            )
            for label in self.get(path).get("items", [])
        }
        return tuple(
            f":{account}:" in labels.get(key, "")
            for key in ("sts_ocm_role", "sts_user_role")
        )


def _red_hat_environment():
    """The Red Hat credentials the environment holds, as Terraform's rhcs provider
    reads them: RHCS_TOKEN (an offline token), or RHCS_CLIENT_ID and
    RHCS_CLIENT_SECRET (a service account). {} when it holds neither."""
    found = {
        key: os.environ[key]
        for key in ("RHCS_TOKEN", "RHCS_CLIENT_ID", "RHCS_CLIENT_SECRET")
        if os.environ.get(key)
    }
    if "RHCS_TOKEN" in found:
        return {"RHCS_TOKEN": found["RHCS_TOKEN"]}
    if {"RHCS_CLIENT_ID", "RHCS_CLIENT_SECRET"} <= set(found):
        return found
    return {}


def _red_hat_sign_in():
    """Red Hat credentials from RHCS_TOKEN, or RHCS_CLIENT_ID and RHCS_CLIENT_SECRET, or
    asked for: used for this run only and not saved."""
    from_env = _red_hat_environment()
    while True:
        if from_env:
            env_vars, from_env = from_env, {}
        else:
            choice = pick(
                [
                    (
                        SERVICE_ACCOUNT,
                        "A Red Hat service account",
                        f"Its client ID and secret, from {SERVICE_ACCOUNTS_PAGE}",
                    ),
                    (OFFLINE_TOKEN, "Your offline token", f"From {TOKEN_PAGE}"),
                ],
                "Which Red Hat credentials should provisioning use? Used for this run "
                "only and not saved.",
            )
            if choice == OFFLINE_TOKEN:
                env_vars = {"RHCS_TOKEN": ui.secret("Offline token")}
            else:
                env_vars = {
                    "RHCS_CLIENT_ID": ask("Client ID: "),
                    "RHCS_CLIENT_SECRET": ui.secret("Client secret"),
                }
        try:
            red_hat = RedHat(env_vars)
        except (OSError, KeyError, ValueError) as e:
            ui.fail(f"Red Hat did not accept these credentials: {e}")
            continue
        ui.ok("Signed in to Red Hat")
        return red_hat


def _choose_name():
    taken = {cluster.name for cluster in cluster_provision.recorded_clusters(PLATFORM)}
    title = (
        f"Name the cluster, e.g. {DEFAULT_NAME} (lowercase letters, digits and "
        "dashes; its VPC and IAM roles are named after it): "
    )
    while True:
        name = ask(title)
        if not NAME_PATTERN.match(name):
            ui.fail(f"{name} isn't a cluster name ROSA takes.")
        elif name in taken:
            ui.fail(f"This machine already provisioned a cluster named {name}.")
        else:
            return name


def _choose_version(red_hat):
    versions = red_hat.versions()
    if not versions:
        raise RuntimeError(
            "Red Hat offers no ROSA version CanyonOS runs on (4.20 or later) here."
        )
    return pick(
        [
            (
                version,
                version,
                "The newest. Pick this unless you need another." if n == 0 else None,
            )
            for n, version in enumerate(versions[:VERSIONS_SHOWN])
        ],
        "Which OpenShift version? (CanyonOS runs on 4.20 or later)",
    )


def _account_roles(iam):
    """The prefix and path of the account's ROSA HCP account roles, or (None, "/")
    when it has none and the cluster makes its own."""
    try:
        role = iam.get_role(
            RoleName=f"{DEFAULT_ACCOUNT_ROLE_PREFIX}-HCP-ROSA-Installer-Role"
        )["Role"]
    except iam.exceptions.NoSuchEntityException:
        return None, "/"
    return DEFAULT_ACCOUNT_ROLE_PREFIX, role["Path"]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Hands a redirect back as an HTTPError, for its Location to be read."""

    def redirect_request(self, *args, **kwargs):
        return None


def _oauth_token(api_url, username, password):
    """One try at an OAuth token for `username` from the cluster's OAuth server, the
    way `oc login` gets one. Returns (token, None), or (None, why it failed)."""
    with urllib.request.urlopen(
        f"{api_url}/.well-known/oauth-authorization-server",
        timeout=REQUEST_TIMEOUT_SECONDS,
    ) as reply:
        endpoint = json.load(reply)["authorization_endpoint"]
    basic = base64.b64encode(f"{username}:{password}".encode()).decode()
    request = urllib.request.Request(
        f"{endpoint}?response_type=token&client_id=openshift-challenging-client",
        headers={"Authorization": f"Basic {basic}", "X-CSRF-Token": "canyonos"},
    )
    try:
        urllib.request.build_opener(_NoRedirect).open(
            request, timeout=REQUEST_TIMEOUT_SECONDS
        )
    except urllib.error.HTTPError as reply:
        location = reply.headers.get("Location", "")
        fragment = urllib.parse.parse_qs(urllib.parse.urlsplit(location).fragment)
        if reply.code == 302 and "access_token" in fragment:
            return fragment["access_token"][0], None
        return None, f"HTTP {reply.code}"
    return None, "no token in the reply"


def _sign_in_token(api_url, username, password):
    """An OAuth token for the cluster-admin user. Retries while the cluster's name
    doesn't resolve yet or its identity provider is still starting."""
    deadline = time.monotonic() + SIGN_IN_SECONDS
    while True:
        try:
            token, error = _oauth_token(api_url, username, password)
        except (OSError, KeyError, ValueError) as e:
            token, error = None, str(e)
        if token:
            return token
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"Couldn't sign in to the cluster as {username}: {error}"
            )
        time.sleep(SIGN_IN_RETRY_SECONDS)


def _check_linked(red_hat, account):
    """Warn when Red Hat has no OCM role or user role linked in the AWS account, which
    making a cluster there needs."""
    try:
        ocm_role, user_role = red_hat.linked_roles(account)
    except (OSError, KeyError, ValueError):
        return
    missing = [
        role
        for role, linked in (("OCM role", ocm_role), ("user role", user_role))
        if not linked
    ]
    if missing:
        ui.warn(
            f"Red Hat has no {' or '.join(missing)} linked in AWS account {account}, "
            "so making the cluster fails. An admin links them with `rosa create "
            "ocm-role` and `rosa create user-role`, or in the ROSA console's account "
            "setup."
        )


def _workers_problem(workers, zones):
    """Why ROSA won't take `workers` over `zones`, or None when it will."""
    if workers < MIN_WORKERS:
        return f"ROSA needs at least {MIN_WORKERS} workers."
    if workers % zones:
        return f"{workers} workers don't spread evenly over {zones} zones."
    return None


def _choose_workers(zones):
    """Ask how many workers, from counts that spread evenly over `zones`, or any."""
    counts = [n * zones for n in range(1, 5) if n * zones >= MIN_WORKERS][:3]
    choice = pick(
        [
            (count, f"{count} workers", "The minimum." if n == 0 else None)
            for n, count in enumerate(counts)
        ]
        + [(ANOTHER_NUMBER, "Another number", f"At least 2, a multiple of {zones}.")],
        "How many worker machines should run your workflows?",
    )
    while choice == ANOTHER_NUMBER:
        text = ask(f"Number of workers (at least 2, a multiple of {zones}): ")
        problem = (
            _workers_problem(int(text), zones)
            if text.isdigit()
            else f"{text} isn't a number."
        )
        if problem:
            ui.fail(problem)
        else:
            choice = int(text)
    return choice


def _check_settings(settings):
    if not NAME_PATTERN.match(settings.name):
        raise RuntimeError(f"{settings.name} isn't a cluster name ROSA takes.")
    problem = _workers_problem(settings.workers, settings.availability_zones)
    if problem:
        raise RuntimeError(problem)
    version = tuple(int(part) for part in settings.openshift_version.split(".")[:2])
    if version < MIN_OPENSHIFT:
        raise RuntimeError(
            f"CanyonOS runs on OpenShift {'.'.join(map(str, MIN_OPENSHIFT))} or "
            f"later, not {settings.openshift_version}."
        )


def _leftover_endpoint_groups(ec2, vpc_id):
    """Remove the security groups ROSA's PrivateLink endpoints may leave in the VPC
    after the cluster is gone, which keep the VPC from being deleted."""
    groups = ec2.describe_security_groups(
        Filters=[{"Name": "vpc-id", "Values": [vpc_id]}]
    )["SecurityGroups"]
    for group in groups:
        if group["GroupName"].endswith("-vpce-private-router"):
            ec2.delete_security_group(GroupId=group["GroupId"])


def _usable_zones(network):
    """The zones of `network` a public cluster can use, each with the private subnet
    (one that reaches out) and the public subnet with the most free addresses."""
    usable = {}
    for zone, subnets in network["zones"].items():
        private = [s for s in subnets["private"] if s["egress"]]
        if private and subnets["public"]:
            usable[zone] = {
                "private": max(private, key=lambda s: s["free_ips"]),
                "public": max(subnets["public"], key=lambda s: s["free_ips"]),
            }
    return usable


def _trusted_oidc_configs(accounts):
    """Red Hat's reusable OIDC configurations whose OIDC provider this AWS account
    already has, so a cluster can reuse them as they are."""
    providers = {
        arn.split(":oidc-provider/", 1)[1]
        for arn in (
            p["Arn"]
            for p in accounts.session.client("iam").list_open_id_connect_providers()[
                "OpenIDConnectProviderList"
            ]
        )
    }
    return [
        config
        for config in accounts.red_hat.oidc_configs()
        if config["issuer_url"].split("://", 1)[-1] in providers
    ]


def _subnet_problems(session, region, subnet_ids):
    """Why the existing subnets `subnet_ids` can't hold a public ROSA cluster, as lines,
    and the subnets missing the tag Kubernetes places load balancers by."""
    found = {}
    for network in networks(session, region):
        for zone, subnets in network["zones"].items():
            for kind in ("private", "public"):
                for subnet in subnets[kind]:
                    found[subnet["id"]] = (network["vpc_id"], zone, kind, subnet)
    problems = [
        f"There is no subnet {s} in {region}." for s in subnet_ids if s not in found
    ]
    given = [found[s] for s in subnet_ids if s in found]
    if len({vpc for vpc, *_ in given}) > 1:
        problems.append("The subnets must all be in one VPC.")
    for zone in sorted({zone for _, zone, _, _ in given}):
        kinds = [(kind, subnet) for _, z, kind, subnet in given if z == zone]
        if not any(kind == "private" and s["egress"] for kind, s in kinds):
            problems.append(
                f"{zone}: no private subnet with a way out (NAT gateway, transit "
                "gateway) among them; the workers couldn't pull images."
            )
        if not any(kind == "public" for kind, _ in kinds):
            problems.append(f"{zone}: no public subnet among them, for the router.")
    untagged = [subnet["id"] for _, _, _, subnet in given if not subnet["elb_tag"]]
    return problems, untagged


def _choose_network(options):
    """Ask for a new VPC or one of `options` (reusable networks). Returns (subnet_ids,
    zones): ([], None) for a new VPC."""
    if not options:
        return [], None
    entries = [
        (
            NEW,
            "A new VPC for this cluster",
            "Deleted with it. Takes a VPC, and an Elastic IP and NAT gateway per zone.",
        )
    ]
    entries += [
        (
            network["vpc_id"],
            f"{network['vpc_id']} {network['name']}".strip(),
            f"{network['cidr']}, zones {', '.join(network['zones'])}. "
            "Existing: CanyonOS never changes or deletes it.",
        )
        for network in options
    ]
    choice = pick(entries, "Which network should the cluster run in?")
    if choice == NEW:
        return [], None
    network = next(n for n in options if n["vpc_id"] == choice)
    zones = list(network["zones"])
    count = 1
    if len(zones) > 1:
        count = pick(
            [
                (1, f"1 zone ({zones[0]})", "Cheapest. Enough to try CanyonOS out."),
                (
                    len(zones),
                    f"{len(zones)} zones ({', '.join(zones)})",
                    "Workers keep running if one data center fails.",
                ),
            ],
            "How many of its Availability Zones should the workers run in?",
        )
    chosen = [network["zones"][zone] for zone in zones[:count]]
    return [z["private_subnet"] for z in chosen] + [
        z["public_subnet"] for z in chosen
    ], count


def _choose_oidc(options):
    """Ask for a new OIDC configuration or one of `options` to reuse; "" for new."""
    if not options:
        return ""
    choice = pick(
        [(NEW, "A new OIDC configuration for this cluster", "Deleted with it.")]
        + [
            (
                config["id"],
                f"Reuse {config['id']}",
                f"Made {config['created']}; this AWS account already trusts it. Kept "
                "when the cluster is deleted.",
            )
            for config in options
        ],
        "Which OIDC configuration should the cluster's operators sign in to AWS with?",
    )
    return "" if choice == NEW else choice


@dataclass
class RosaAccounts(Accounts):
    """An AWS session and Red Hat: ROSA makes the cluster through both."""

    session: Any = None
    red_hat: Any = None

    def terraform_env(self, region):
        return {**terraform_environment(self.session, region), **self.red_hat.env}


@dataclass(kw_only=True)
class RosaSettings(ClusterSettings):
    # e.g. 4.22.22; "" for the newest Red Hat offers that CanyonOS runs on.
    openshift_version: str = ""
    # Zones the VPC and workers span, and the workers: a multiple of the zones, 2+.
    availability_zones: int = 1
    workers: int = 2
    machine_type: str = "m5.xlarge"
    # The ARN of the policy the account requires on every IAM role; "" for none.
    permissions_boundary: str = ""
    # Your own tags on everything made in AWS, besides CanyonOS's.
    tags: dict = field(default_factory=dict)
    # Existing subnets to make the cluster in (a private one that reaches out and a
    # public one in each of its zones); none: a VPC of its own. CanyonOS never changes
    # or deletes them. availability_zones and machine_cidr follow from them.
    subnet_ids: list = field(default_factory=list)
    machine_cidr: str = ""
    # An existing Red Hat OIDC configuration to reuse (cluster_options lists them);
    # "": one of its own. The issuer URL follows from it.
    oidc_config_id: str = ""
    oidc_endpoint_url: str = ""


class RosaPlatform(Platform):
    name = PLATFORM
    title = "ROSA"
    settings_type = RosaSettings

    def errors(self):
        return aws_errors()

    def sign_in(self):
        session = sign_in()
        account = session.client(
            "sts", region_name=session.region_name or STS_REGION
        ).get_caller_identity()["Account"]
        red_hat = _red_hat_sign_in()
        _check_linked(red_hat, account)
        return RosaAccounts(account=account, session=session, red_hat=red_hat)

    def accounts_from_environment(self):
        """AWS from boto3's default credentials (AWS_PROFILE, AWS_REGION, ...), Red
        Hat from RHCS_TOKEN, or RHCS_CLIENT_ID and RHCS_CLIENT_SECRET."""
        import boto3

        session = boto3.Session()
        account = session.client(
            "sts", region_name=session.region_name or STS_REGION
        ).get_caller_identity()["Account"]
        red_hat_env = _red_hat_environment()
        if not red_hat_env:
            raise RuntimeError(
                "Making a ROSA cluster needs Red Hat credentials: set RHCS_TOKEN to an "
                f"offline token ({TOKEN_PAGE}), or RHCS_CLIENT_ID and RHCS_CLIENT_SECRET "
                f"to a service account's ({SERVICE_ACCOUNTS_PAGE})."
            )
        try:
            red_hat = RedHat(red_hat_env)
        except (OSError, KeyError, ValueError) as e:
            raise RuntimeError(f"Red Hat did not accept the credentials: {e}") from None
        return RosaAccounts(account=account, session=session, red_hat=red_hat)

    def reusable(self, accounts, region):
        """Networks with a usable private and public subnet in at least one zone, and
        Red Hat OIDC configurations this account already trusts."""
        options = []
        for network in networks(accounts.session, region):
            zones = _usable_zones(network)
            if zones:
                options.append(
                    {
                        "vpc_id": network["vpc_id"],
                        "name": network["name"],
                        "cidr": network["cidr"],
                        "zones": {
                            zone: {
                                "private_subnet": z["private"]["id"],
                                "public_subnet": z["public"]["id"],
                                "load_balancer_tags": z["private"]["elb_tag"]
                                and z["public"]["elb_tag"],
                            }
                            for zone, z in zones.items()
                        },
                    }
                )
        return {"networks": options, "oidc_configs": _trusted_oidc_configs(accounts)}

    def complete(self, settings, accounts):
        changes = {}
        if not settings.openshift_version:
            versions = accounts.red_hat.versions()
            if not versions:
                raise RuntimeError(
                    "Red Hat offers no ROSA version CanyonOS runs on (4.20 or later) "
                    "here."
                )
            changes["openshift_version"] = versions[0]
        if settings.subnet_ids:
            from botocore.exceptions import ClientError

            ec2 = accounts.session.client("ec2", region_name=settings.region)
            try:
                subnets = ec2.describe_subnets(SubnetIds=settings.subnet_ids)["Subnets"]
            except ClientError as e:
                raise RuntimeError(f"Couldn't read the subnets: {e}") from None
            vpcs = {s["VpcId"] for s in subnets}
            if len(vpcs) == 1 and not settings.machine_cidr:
                changes["machine_cidr"] = ec2.describe_vpcs(VpcIds=list(vpcs))["Vpcs"][
                    0
                ]["CidrBlock"]
            changes["availability_zones"] = len(
                {s["AvailabilityZone"] for s in subnets}
            )
        if settings.oidc_config_id and not settings.oidc_endpoint_url:
            config = next(
                (
                    c
                    for c in accounts.red_hat.oidc_configs()
                    if c["id"] == settings.oidc_config_id
                ),
                None,
            )
            if config is None:
                raise RuntimeError(
                    f"Red Hat has no reusable OIDC configuration {settings.oidc_config_id}."
                )
            changes["oidc_endpoint_url"] = config["issuer_url"]
        return replace(settings, **changes) if changes else settings

    def ask(self, accounts):
        region = choose_region(
            accounts.session, "Which AWS region should the cluster run in?"
        )
        name = _choose_name()
        version = _choose_version(accounts.red_hat)
        options = self.reusable(accounts, region)
        subnet_ids, zones = _choose_network(options["networks"])
        if not subnet_ids:
            zones = pick(
                [(count, title, detail) for count, title, detail in ZONES],
                "How many Availability Zones (separate AWS data centers) should the "
                "workers run in? Red Hat runs the control plane across zones either "
                "way.",
            )
        workers = _choose_workers(zones)
        oidc_config_id = _choose_oidc(options["oidc_configs"])
        machine_type = pick(
            [(kind, kind, detail) for kind, detail in MACHINE_TYPES],
            "Which machine type should the workers be?",
        )
        return RosaSettings(
            name=name,
            region=region,
            openshift_version=version,
            availability_zones=zones,
            workers=workers,
            machine_type=machine_type,
            subnet_ids=subnet_ids,
            oidc_config_id=oidc_config_id,
            permissions_boundary=choose_boundary(),
            tags=choose_tags(),
            install=choose_install(),
        )

    def summary(self, settings, accounts):
        role_prefix, _ = _account_roles(accounts.session.client("iam"))
        zones = settings.availability_zones
        lines = [
            f"In AWS account {accounts.account}, {settings.region}:",
            f"ROSA cluster {settings.name}: OpenShift {settings.openshift_version}, "
            "hosted control planes",
            f"{settings.workers} {settings.machine_type} workers in {zones} "
            f"zone{'s' if zones > 1 else ''}",
            *self._network_lines(settings, accounts),
            f"Reuses the OIDC configuration {settings.oidc_config_id} (kept when the "
            "cluster is deleted)"
            if settings.oidc_config_id
            else "A new OIDC configuration and its OIDC provider in AWS",
            f"Operator roles {settings.name}-*",
            f"Reuses the account roles {role_prefix}-HCP-ROSA-*"
            if role_prefix
            else f"Account roles {settings.name}-account-HCP-ROSA-* (the account "
            "has none)",
        ]
        if settings.permissions_boundary:
            lines.append(f"Permissions boundary {settings.permissions_boundary}")
        own = "".join(f"{k}={v}, " for k, v in settings.tags.items())
        lines.append(f"Tags {own}CreatedBy and {PROVISION_ID_TAG} (CanyonOS's)")
        return lines

    def check(self, settings, accounts):
        """Refuse settings ROSA won't take, and ask IAM's policy simulator whether
        this identity may make the cluster's IAM roles (by their real names, with the
        boundary), its VPC (with the tags) and its OIDC provider."""
        _check_settings(settings)
        problems = []
        if settings.subnet_ids:
            problems += _subnet_problems(
                accounts.session, settings.region, settings.subnet_ids
            )[0]
        else:
            problems += network_room(
                accounts.session,
                settings.region,
                vpcs=1,
                elastic_ips=settings.availability_zones,
            )
        if settings.oidc_config_id and settings.oidc_config_id not in {
            c["id"] for c in _trusted_oidc_configs(accounts)
        }:
            problems.append(
                f"The OIDC configuration {settings.oidc_config_id} isn't one this AWS "
                "account trusts (no OIDC provider for it): reuse another, or make a new "
                "one."
            )
        if problems:
            raise RuntimeError(
                "This cluster can't be made as set, so nothing was made:\n  - "
                + "\n  - ".join(problems)
            )
        role_prefix, role_path = _account_roles(accounts.session.client("iam"))
        account = accounts.account
        boundary = (
            {"iam:PermissionsBoundary": settings.permissions_boundary}
            if settings.permissions_boundary
            else {}
        )
        role = f"arn:aws:iam::{account}:role{role_path}{settings.name}"
        requests = [
            ("iam:CreateRole", f"{role}-kube-system-kube-controller-manager", boundary)
        ]
        if not settings.subnet_ids:
            requests.append(
                (
                    "ec2:CreateVpc",
                    f"arn:aws:ec2:{settings.region}:{account}:vpc/*",
                    {
                        f"aws:RequestTag/{key}": value
                        for key, value in settings.tags.items()
                    },
                )
            )
        if not settings.oidc_config_id:
            requests.append(
                (
                    "iam:CreateOpenIDConnectProvider",
                    f"arn:aws:iam::{account}:oidc-provider/oidc.op1.openshiftapps.com/"
                    f"{settings.name}",
                    {},
                )
            )
        if role_prefix is None:
            requests.append(
                ("iam:CreateRole", f"{role}-account-HCP-ROSA-Installer-Role", boundary)
            )
        found = refused(accounts.session, requests)
        if found:
            raise RuntimeError(
                "AWS would refuse to make this cluster, so nothing was made:\n  "
                + "\n  ".join(found)
                + "\nMany accounts allow IAM roles only with a name prefix (e.g. "
                "rosa-) or a permissions boundary: change the cluster's name or "
                "boundary, or ask your AWS admin."
            )

    def variables(self, settings, accounts, cluster):
        _check_settings(settings)
        role_prefix, role_path = _account_roles(accounts.session.client("iam"))
        return {
            "cluster_name": settings.name,
            "region": settings.region,
            "openshift_version": settings.openshift_version,
            "availability_zones": settings.availability_zones,
            "workers": settings.workers,
            "machine_type": settings.machine_type,
            "account_role_prefix": role_prefix,
            "role_path": role_path,
            "permissions_boundary": settings.permissions_boundary,
            "tags": {**settings.tags, **cluster.tags()},
            "subnet_ids": settings.subnet_ids,
            "machine_cidr": settings.machine_cidr,
            "oidc_config_id": settings.oidc_config_id,
            "oidc_endpoint_url": settings.oidc_endpoint_url,
        }

    @staticmethod
    def _network_lines(settings, accounts):
        zones = settings.availability_zones
        if not settings.subnet_ids:
            return [
                f"VPC {settings.name}: public and private subnets, and a NAT gateway "
                f"with an Elastic IP in each of its {zones} zone{'s' if zones > 1 else ''}"
            ]
        _, untagged = _subnet_problems(
            accounts.session, settings.region, settings.subnet_ids
        )
        lines = [
            f"In the existing subnets {', '.join(settings.subnet_ids)} "
            f"({settings.machine_cidr}); CanyonOS never changes or deletes them"
        ]
        if untagged:
            lines.append(
                f"Note: {', '.join(untagged)} lack the {PUBLIC_ELB_TAG} (public) or "
                f"{PRIVATE_ELB_TAG} (private) tag Kubernetes places load balancers by; "
                "add it, or the router's load balancer may not come up"
            )
        return lines

    def connect(self, cluster, outputs):
        """Sign in as the cluster-admin user the module made, then as a cluster-admin
        ServiceAccount whose token canyonos can send."""
        token = _sign_in_token(
            outputs["api_url"], outputs["admin_username"], outputs["admin_password"]
        )
        cluster_provision.use_context(cluster, outputs["api_url"], token)
        sign_in_as_admin_account(cluster.context)
        password_file = cluster.dir / PASSWORD_FILE
        write_private_file(password_file, outputs["admin_password"])
        apps_domain = kubectl(
            ["get", "ingresses.config.openshift.io", "cluster",
             "-o", "jsonpath={.spec.domain}"],
            check=False,
        ).stdout.strip()  # fmt: skip
        return {
            "admin_username": outputs["admin_username"],
            "admin_password_file": str(password_file),
            "apps_domain": apps_domain,
        }

    def clear_destroy_blocker(self, cluster, accounts, outputs, error):
        vpc_id = outputs.get("vpc_id")
        if "DependencyViolation" not in error or not vpc_id:
            return False
        _leftover_endpoint_groups(
            accounts.session.client("ec2", region_name=cluster.region), vpc_id
        )
        return True

    def show_next_steps(self, made):
        details = made.details
        apps = details.get("apps_domain") or "<apps domain>"
        ui.say(
            f"Console: {made.console_url}, as {details['admin_username']} with the "
            f"password in {details['admin_password_file']}"
        )
        ui.say("For each namespace a workflow group runs in:")
        ui.command(
            "kubectl create namespace acme\n"
            "kubectl -n acme create rolebinding canyonos-build-image-builder "
            "--clusterrole=system:image-builder --serviceaccount=acme:canyonos-build"
        )
        ui.say("and in its workflow_group.yaml:")
        ui.command(
            "target: kubernetes\n"
            "kubernetes:\n"
            "  namespace: acme\n"
            "  registry: image-registry.openshift-image-registry.svc:5000/acme\n"
            "  endpoint:\n"
            f"    host: acme.{apps}\n"
            "    tls: true"
        )


ROSA = RosaPlatform()
# The name cluster_provision.get_platform looks it up by.
platform = ROSA


def provision():
    """Walk through making a ROSA cluster in the terminal. Returns True once it is
    ready, False if you backed out or a step failed."""
    return cluster_provision.run_provision(ROSA)


def teardown():
    """Walk through deleting a ROSA cluster provisioned from this machine. Returns True
    once it is gone or there was none, False if you backed out or a step failed."""
    return cluster_provision.run_teardown(ROSA)
