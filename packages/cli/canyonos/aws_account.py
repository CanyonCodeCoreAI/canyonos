# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The AWS account `canyonos provision` works in: signing in, and the region, asked the
same way by every provisioner that makes something in AWS.
"""

import re
import shutil
import subprocess

from canyonos import ui
from canyonos.provision import Cancelled, ask, pick

STS_REGION = "us-east-1"
REGIONS = (
    "us-east-1",
    "us-east-2",
    "us-west-2",
    "eu-west-1",
    "eu-central-1",
    "ap-southeast-1",
    "ap-northeast-1",
)

DEFAULT_CREDENTIALS = "__default__"
AWS_LOGIN = "__aws_login__"
ACCESS_KEYS = "__access_keys__"
OTHER_REGION = "__other__"
NO_BOUNDARY = "__no_boundary__"
NO_TAGS = "__no_tags__"


def sign_in():
    """Ask which AWS credentials to use and return a boto3 session with them, once AWS
    accepts them. Raises Cancelled when you back out."""
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError

    while True:
        entries = [
            (
                DEFAULT_CREDENTIALS,
                "Use your default AWS credentials",
                "Environment variables, AWS_PROFILE, ~/.aws, SSO or an earlier "
                "`aws login`.",
            )
        ]
        if shutil.which("aws"):
            entries.append(
                (
                    AWS_LOGIN,
                    "Sign in with your browser",
                    "Runs `aws login` with your AWS console sign-in.",
                )
            )
        entries.append(
            (
                ACCESS_KEYS,
                "Enter an access key and secret",
                "Used for this run only and not saved.",
            )
        )
        choice = pick(entries, "Which AWS credentials should provisioning use?")
        if choice == AWS_LOGIN:
            if subprocess.run(["aws", "login"]).returncode != 0:
                ui.fail("`aws login` did not finish.")
                continue
            session = boto3.Session()
        elif choice == ACCESS_KEYS:
            try:
                session = boto3.Session(
                    aws_access_key_id=ask("Access key ID: "),
                    aws_secret_access_key=ui.secret("Secret access key"),
                )
            except Cancelled:
                continue
        else:
            session = boto3.Session()
        try:
            identity = session.client(
                "sts", region_name=session.region_name or STS_REGION
            ).get_caller_identity()
        except (BotoCoreError, ClientError) as e:
            ui.fail(f"AWS did not accept these credentials: {e}")
            continue
        ui.ok(f"Signed in to AWS account {identity['Account']} as {identity['Arn']}")
        return session


def choose_region(session, title):
    """Ask for a region under `title`, the session's default first. Raises Cancelled
    when you back out."""
    current = session.region_name
    regions = [current, *(r for r in REGIONS if r != current)] if current else REGIONS
    entries = [
        (region, region, "Your default region" if region == current else None)
        for region in regions
    ]
    entries.append((OTHER_REGION, "Another region", None))
    region = pick(entries, title)
    if region == OTHER_REGION:
        region = ask("Region, e.g. ca-central-1: ")
    return region


def terraform_environment(session, region):
    """The environment Terraform signs in to AWS with as `session` does. Access keys
    entered for this run are passed as they are; any other credentials Terraform reads
    from where boto3 found them (the environment, AWS_PROFILE, SSO), so it refreshes
    short-lived ones itself during a long run instead of using a copy that expires."""
    aws = {"AWS_REGION": region}
    credentials = session.get_credentials()
    if credentials.method == "explicit":
        frozen = credentials.get_frozen_credentials()
        aws["AWS_ACCESS_KEY_ID"] = frozen.access_key
        aws["AWS_SECRET_ACCESS_KEY"] = frozen.secret_key
    return aws


def choose_boundary():
    """Ask for the permissions boundary the account requires on new IAM roles: its
    ARN, or "" for none."""
    choice = pick(
        [
            (NO_BOUNDARY, "No", "The account has no such rule. Most don't."),
            (
                "",
                "Yes, enter the boundary policy",
                "Every IAM role made for the cluster gets it as its upper limit.",
            ),
        ],
        "Does your AWS account require a permissions boundary on the IAM roles made "
        "for the cluster? Some company accounts do: ask your AWS admin if unsure.",
    )
    if choice == NO_BOUNDARY:
        return ""
    while True:
        arn = ask("Boundary policy ARN, e.g. arn:aws:iam::<account>:policy/<name>: ")
        if arn.startswith("arn:aws") and ":policy/" in arn:
            return arn
        ui.fail("That isn't an IAM policy ARN.")


def choose_tags():
    """Ask for tags of your own to put on everything made in AWS, as a dict."""
    choice = pick(
        [
            (
                NO_TAGS,
                "No",
                "CanyonOS still tags everything it makes, to find it again.",
            ),
            (
                "",
                "Yes, add tags",
                "Put on everything made in AWS. Keys and values are case-sensitive.",
            ),
        ],
        "Does your AWS account require tags of its own on new resources?",
    )
    if choice == NO_TAGS:
        return {}
    while True:
        text = ask("Tags as key=value, separated by commas, e.g. team=platform: ")
        pairs = [part.strip().split("=", 1) for part in text.split(",") if part.strip()]
        if pairs and all(len(pair) == 2 and pair[0] for pair in pairs):
            return {key.strip(): value.strip() for key, value in pairs}
        ui.fail("Write each tag as key=value.")


# Service Quotas codes: VPCs per Region, and EC2-VPC Elastic IPs.
VPC_QUOTA = ("vpc", "L-F678F1CE")
ELASTIC_IP_QUOTA = ("ec2", "L-0263D0A3")
# Subnet tags that tell Kubernetes where to put a load balancer; only the key counts.
PUBLIC_ELB_TAG = "kubernetes.io/role/elb"
PRIVATE_ELB_TAG = "kubernetes.io/role/internal-elb"


def _limit(session, region, service, code):
    """An account's limit in `region`, or None when it can't be read."""
    from botocore.exceptions import BotoCoreError, ClientError

    quotas = session.client("service-quotas", region_name=region)
    try:
        try:
            found = quotas.get_service_quota(ServiceCode=service, QuotaCode=code)
        except quotas.exceptions.NoSuchResourceException:
            # Never changed in this account: AWS's default.
            found = quotas.get_aws_default_service_quota(
                ServiceCode=service, QuotaCode=code
            )
        return int(found["Quota"]["Value"])
    except (BotoCoreError, ClientError, KeyError, ValueError):
        return None


def network_room(session, region, vpcs, elastic_ips):
    """What would stop `vpcs` new VPCs and `elastic_ips` new Elastic IPs in `region`
    for the account's limits, as lines; [] when they fit, or the limits can't be read."""
    ec2 = session.client("ec2", region_name=region)
    problems = []
    for needed, (service, code), used, what in (
        (vpcs, VPC_QUOTA, lambda: len(ec2.describe_vpcs()["Vpcs"]), "VPCs"),
        (
            elastic_ips,
            ELASTIC_IP_QUOTA,
            lambda: len(ec2.describe_addresses()["Addresses"]),
            "Elastic IPs",
        ),
    ):
        limit = _limit(session, region, service, code)
        if limit is None:
            continue
        in_use = used()
        if in_use + needed > limit:
            problems.append(
                f"{region} has {in_use} of its {limit} {what}, and this needs {needed} "
                f"more: free {in_use + needed - limit}, use an existing network, or ask "
                "AWS for a higher limit (Service Quotas)."
            )
    return problems


def _name(tags):
    return next((t["Value"] for t in tags or [] if t["Key"] == "Name"), "")


def networks(session, region):
    """The VPCs in `region` a cluster could be made in, each with its subnets by zone: a
    subnet is public when its route table sends 0.0.0.0/0 to an internet gateway, and
    private otherwise, `egress` saying how it reaches out (NAT gateway, transit
    gateway, ...) or None when it can't. Returns [{vpc_id, name, cidr, zones: {zone:
    {"public": [subnet], "private": [subnet]}}}], a subnet being {id, name, free_ips,
    egress, elb_tag}."""
    ec2 = session.client("ec2", region_name=region)
    tables = ec2.describe_route_tables()["RouteTables"]
    found = []
    for vpc in ec2.describe_vpcs()["Vpcs"]:
        vpc_id = vpc["VpcId"]
        mine = [t for t in tables if t["VpcId"] == vpc_id]
        main = next(
            (t for t in mine for a in t.get("Associations", []) if a.get("Main")), None
        )
        zones = {}
        subnets = ec2.describe_subnets(
            Filters=[{"Name": "vpc-id", "Values": [vpc_id]}]
        )["Subnets"]
        for subnet in subnets:
            table = next(
                (
                    t
                    for t in mine
                    for a in t.get("Associations", [])
                    if a.get("SubnetId") == subnet["SubnetId"]
                ),
                main,
            )
            default = next(
                (
                    r
                    for r in (table or {}).get("Routes", [])
                    if r.get("DestinationCidrBlock") == "0.0.0.0/0"
                    and r.get("State", "active") == "active"
                ),
                {},
            )
            public = default.get("GatewayId", "").startswith("igw-")
            egress = next(
                (
                    label
                    for key, label in (
                        ("GatewayId", "internet gateway"),
                        ("NatGatewayId", "NAT gateway"),
                        ("TransitGatewayId", "transit gateway"),
                        ("NetworkInterfaceId", "network appliance"),
                        ("VpcPeeringConnectionId", "VPC peering"),
                    )
                    if default.get(key)
                ),
                None,
            )
            tags = {t["Key"] for t in subnet.get("Tags", [])}
            entry = {
                "id": subnet["SubnetId"],
                "name": _name(subnet.get("Tags")),
                "free_ips": subnet["AvailableIpAddressCount"],
                "egress": egress,
                "elb_tag": (PUBLIC_ELB_TAG if public else PRIVATE_ELB_TAG) in tags,
            }
            zone = zones.setdefault(
                subnet["AvailabilityZone"], {"public": [], "private": []}
            )
            zone["public" if public else "private"].append(entry)
        found.append(
            {
                "vpc_id": vpc_id,
                "name": _name(vpc.get("Tags")),
                "cidr": vpc["CidrBlock"],
                "zones": dict(sorted(zones.items())),
            }
        )
    return found


def refused(session, requests):
    """Which of `requests`, each (action, resource ARN, {condition key: value}), IAM's
    policy simulator says the signed-in identity may not do, as "action on resource"
    lines, without doing any of them. [] when it allows them all, or when the
    simulator can't be asked (no permission to use it): then only trying tells."""
    from botocore.exceptions import BotoCoreError, ClientError

    iam = session.client("iam")
    try:
        arn = session.client(
            "sts", region_name=session.region_name or STS_REGION
        ).get_caller_identity()["Arn"]
        # An assumed role's session is simulated as its role.
        assumed = re.match(r"arn:[\w-]+:sts::\d+:assumed-role/([^/]+)/", arn)
        if assumed:
            arn = iam.get_role(RoleName=assumed.group(1))["Role"]["Arn"]
        found = []
        for action, resource, context in requests:
            result = iam.simulate_principal_policy(
                PolicySourceArn=arn,
                ActionNames=[action],
                ResourceArns=[resource],
                ContextEntries=[
                    {
                        "ContextKeyName": key,
                        "ContextKeyValues": [value],
                        "ContextKeyType": "string",
                    }
                    for key, value in context.items()
                ],
            )["EvaluationResults"][0]
            if result["EvalDecision"] != "allowed":
                found.append(f"{action} on {resource}")
    except (BotoCoreError, ClientError):
        return []
    return found


def errors():
    """The errors boto3 raises, for a provisioner to report as a failed step."""
    from botocore.exceptions import BotoCoreError, ClientError

    return (BotoCoreError, ClientError)
