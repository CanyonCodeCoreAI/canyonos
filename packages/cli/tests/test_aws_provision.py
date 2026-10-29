# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import stat
import sys
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from canyonos import aws_provision, provision


def _client_error(code, message=""):
    return ClientError({"Error": {"Code": code, "Message": message}}, "Operation")


def test_a_new_group_lets_its_machines_and_you_in():
    rules = aws_provision.group_rules("sg-1", "203.0.113.7")

    assert rules[0]["UserIdGroupPairs"][0]["GroupId"] == "sg-1"
    assert (rules[0]["FromPort"], rules[0]["ToPort"]) == (0, 65535)
    assert [(r["FromPort"], r["ToPort"]) for r in rules[1:]] == [(22, 22), (8080, 8082)]
    assert {r["IpRanges"][0]["CidrIp"] for r in rules[1:]} == {"203.0.113.7/32"}


def test_without_your_ip_only_the_machines_get_in():
    assert len(aws_provision.group_rules("sg-1", None)) == 1


def test_an_existing_group_is_only_missing_what_it_does_not_allow():
    group = {
        "GroupId": "sg-1",
        "IpPermissions": [
            {"IpProtocol": "-1", "UserIdGroupPairs": [{"GroupId": "sg-1"}]},
            {
                "IpProtocol": "tcp",
                "FromPort": 22,
                "ToPort": 22,
                "IpRanges": [{"CidrIp": "0.0.0.0/0"}],
            },
        ],
    }

    missing = aws_provision.missing_rules(group, "203.0.113.7")

    assert [(r["FromPort"], r["ToPort"]) for r in missing] == [(8080, 8082)]


def test_a_rule_for_another_group_does_not_count():
    group = {
        "GroupId": "sg-1",
        "IpPermissions": [
            {"IpProtocol": "-1", "UserIdGroupPairs": [{"GroupId": "sg-other"}]}
        ],
    }

    assert aws_provision.missing_rules(group, None) == aws_provision.group_rules(
        "sg-1", None
    )


def _request(**overrides):
    return aws_provision.launch_request(
        **{
            "ami_id": "ami-1",
            "root_device": "/dev/sda1",
            "root_volume_gib": 30,
            "machine_type": "t3.large",
            "subnet_id": "subnet-1",
            "group_id": "sg-1",
            "key_name": "key-1",
            "profile_name": "canyonos-controller",
            "provision_id": "abc123",
            "version": "1.2.3",
            **overrides,
        }
    )


def test_the_machine_lets_its_containers_use_the_role():
    request = _request()

    assert request["MetadataOptions"]["HttpTokens"] == "required"
    assert request["MetadataOptions"]["HttpPutResponseHopLimit"] == 2
    assert request["IamInstanceProfile"] == {"Name": "canyonos-controller"}
    assert request["NetworkInterfaces"][0] == {
        "DeviceIndex": 0,
        "SubnetId": "subnet-1",
        "Groups": ["sg-1"],
        "AssociatePublicIpAddress": True,
    }
    assert "CANYONOS_VERSION=v1.2.3" in request["UserData"]


def test_the_machine_installs_the_same_release_as_this_cli():
    script = aws_provision.user_data("1.2.3")

    # The installer comes from that release's tag, and is told to install it.
    assert "/CanyonCodeCoreAI/canyonos/v1.2.3/packages/cli/install.sh" in script
    assert "CANYONOS_VERSION=v1.2.3" in script
    assert "/main/" not in script


@pytest.mark.parametrize("dev", [False, True])
def test_the_machine_gets_swap_that_survives_reboots(dev):
    script = aws_provision.user_data("1.2.3", dev=dev)

    assert "fallocate -l 2G /swapfile" in script
    assert "swapon /swapfile" in script
    assert "/swapfile none swap sw 0 0" in script
    # Before installing anything, so the installs have it too.
    assert script.index("swapon /swapfile") < script.index("apt-get update")


def _urlopen_raising(error):
    def urlopen(request, timeout):
        raise error

    return urlopen


def test_a_missing_release_is_reported(monkeypatch):
    error = aws_provision.urllib.error.HTTPError("url", 404, "Not Found", {}, None)
    monkeypatch.setattr(
        aws_provision.urllib.request, "urlopen", _urlopen_raising(error)
    )

    assert aws_provision.release_exists("9.9.9") is False


def test_an_unreachable_github_is_not_a_missing_release(monkeypatch):
    monkeypatch.setattr(
        aws_provision.urllib.request, "urlopen", _urlopen_raising(OSError("offline"))
    )

    assert aws_provision.release_exists("1.2.3") is None


def test_stop_never_terminates_the_controller_machine():
    tags = _request()["TagSpecifications"][0]["Tags"]

    assert {"Key": "CreatedBy", "Value": "EC2 Fast Launch"} not in tags


def test_the_machine_and_its_disk_carry_the_provision_id():
    for spec in _request()["TagSpecifications"]:
        assert {"Key": "canyonos-provision", "Value": "abc123"} in spec["Tags"]
        assert {"Key": "CreatedBy", "Value": "canyonos provision"} in spec["Tags"]


def test_the_disk_is_never_smaller_than_the_ami_snapshot():
    def image(snapshot_gib):
        return {
            "RootDeviceName": "/dev/sda1",
            "BlockDeviceMappings": [
                {"DeviceName": "/dev/sdb", "Ebs": {"VolumeSize": 500}},
                {"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": snapshot_gib}},
            ],
        }

    assert aws_provision.root_volume(image(32)) == ("/dev/sda1", 32)
    assert aws_provision.root_volume(image(8)) == ("/dev/sda1", 30)


def test_no_role_means_no_instance_profile():
    assert "IamInstanceProfile" not in _request(profile_name=None)


def test_the_role_is_created_once_and_reused():
    iam = MagicMock()
    iam.get_instance_profile.return_value = {"InstanceProfile": {"Roles": []}}

    assert aws_provision.ensure_controller_role(iam) == "canyonos-controller"
    iam.add_role_to_instance_profile.assert_called_once()

    iam.reset_mock()
    iam.create_role.side_effect = _client_error("EntityAlreadyExists")
    iam.create_instance_profile.side_effect = _client_error("EntityAlreadyExists")
    iam.get_instance_profile.return_value = {
        "InstanceProfile": {"Roles": [{"RoleName": "canyonos-controller"}]}
    }

    aws_provision.ensure_controller_role(iam)

    iam.put_role_policy.assert_called_once()
    iam.add_role_to_instance_profile.assert_not_called()


def test_other_iam_errors_stop_provision():
    iam = MagicMock()
    iam.create_role.side_effect = _client_error("AccessDenied")

    with pytest.raises(ClientError):
        aws_provision.ensure_controller_role(iam)


def test_a_new_private_key_is_readable_only_by_you(tmp_path):
    path = aws_provision.save_private_key("canyonos-abc", "KEY", ssh_dir=tmp_path)

    assert path.read_text() == "KEY"
    # Windows keeps only the read-only bit of a file's mode.
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    with pytest.raises(FileExistsError):
        aws_provision.save_private_key("canyonos-abc", "OTHER", ssh_dir=tmp_path)


def test_launch_waits_for_a_new_instance_profile(monkeypatch):
    monkeypatch.setattr(aws_provision.time, "sleep", lambda _: None)
    ec2 = MagicMock()
    ec2.run_instances.side_effect = [
        _client_error(
            "InvalidParameterValue", "Value (x) for parameter iamInstanceProfile..."
        ),
        {"Instances": [{"InstanceId": "i-1"}]},
    ]

    assert aws_provision.run_instances_when_profile_ready(ec2, {}) == "i-1"
    assert ec2.run_instances.call_count == 2


def test_launch_does_not_retry_other_errors():
    ec2 = MagicMock()
    ec2.run_instances.side_effect = _client_error("InsufficientInstanceCapacity")

    with pytest.raises(ClientError):
        aws_provision.run_instances_when_profile_ready(ec2, {})
    assert ec2.run_instances.call_count == 1


def test_public_subnets_are_the_ones_routed_to_an_internet_gateway():
    internet = [{"DestinationCidrBlock": "0.0.0.0/0", "GatewayId": "igw-1"}]
    ec2 = MagicMock()
    ec2.can_paginate.return_value = False
    ec2.describe_route_tables.return_value = {
        "RouteTables": [
            {"Associations": [{"Main": True}], "Routes": internet},
            {"Associations": [{"SubnetId": "subnet-private"}], "Routes": []},
        ]
    }
    provision_run = aws_provision._AwsProvision()
    provision_run.ec2 = ec2
    subnets = [{"SubnetId": "subnet-main"}, {"SubnetId": "subnet-private"}]

    assert provision_run._subnets_with_internet_route("vpc-1", subnets) == {
        "subnet-main"
    }


def test_provision_needs_a_terminal(monkeypatch):
    monkeypatch.setattr(provision, "is_interactive", lambda: False)

    assert provision.run_provision() is False


def _fake_ec2(groups=(), keys=(), machines=()):
    """A fake EC2 client listing the given provision-tagged groups and key pairs, and
    `machines` as dicts of `id`, `groups`, `key`, whether it is an `agent`, and the
    machine it was `deployed_from`. The
    groups and key pairs carry the provision tag they are asked for. Its
    `describe_instances` answers the group, key pair and provision-tag filters."""
    ec2 = MagicMock()
    ec2.can_paginate.return_value = False

    def tags(Filters):
        id_filter = Filters[0]
        return [
            {"Key": "CreatedBy", "Value": "canyonos provision"},
            {"Key": id_filter["Name"][len("tag:") :], "Value": id_filter["Values"][0]},
        ]

    ec2.describe_security_groups.side_effect = lambda Filters: {
        "SecurityGroups": [
            {"GroupId": group_id, "Tags": tags(Filters)} for group_id in groups
        ]
    }
    ec2.describe_key_pairs.side_effect = lambda Filters: {
        "KeyPairs": [{"KeyName": name, "Tags": tags(Filters)} for name in keys]
    }

    def describe_instances(Filters):
        found = []
        for machine in machines:
            created_by = "EC2 Fast Launch" if machine.get("agent") else "someone"
            values = {
                "instance.group-id": machine.get("groups", []),
                "key-name": [machine.get("key")],
                "tag:CreatedBy": [created_by],
                "tag:canyonos-deployed-from": [machine.get("deployed_from")],
                "instance-state-name": ["running"],
            }
            if all(set(f["Values"]) & set(values[f["Name"]]) for f in Filters):
                tags = [{"Key": "CreatedBy", "Value": created_by}]
                if machine.get("deployed_from"):
                    tags.append(
                        {
                            "Key": "canyonos-deployed-from",
                            "Value": machine["deployed_from"],
                        }
                    )
                found.append({"InstanceId": machine["id"], "Tags": tags})
        return {"Reservations": [{"Instances": found}]}

    ec2.describe_instances.side_effect = describe_instances
    return ec2


def test_removal_finds_what_the_provision_run_tagged():
    ec2 = _fake_ec2(
        groups=["sg-1"],
        keys=["canyonos-abc123"],
        machines=[
            {"id": "i-controller", "groups": ["sg-1"], "key": "canyonos-abc123"},
            {"id": "i-agent", "groups": ["sg-1"], "agent": True},
        ],
    )

    plan = aws_provision.removal_plan(ec2, "abc123", ["i-controller"])

    assert plan == {
        "machine_ids": ["i-controller"],
        "agent_ids": ["i-agent"],
        "group_ids": ["sg-1"],
        "key_names": ["canyonos-abc123"],
        "kept": {},
        "tags": {
            "sg-1": "CreatedBy=canyonos provision, canyonos-provision=abc123",
            "i-agent": "CreatedBy=EC2 Fast Launch",
            "canyonos-abc123": "CreatedBy=canyonos provision, canyonos-provision=abc123",
        },
    }
    by_provision = [{"Name": "tag:canyonos-provision", "Values": ["abc123"]}]
    ec2.describe_security_groups.assert_called_once_with(Filters=by_provision)
    ec2.describe_key_pairs.assert_called_once_with(Filters=by_provision)


def test_removal_finds_the_agent_machines_the_machine_deployed_in_any_group():
    ec2 = _fake_ec2(
        machines=[
            {"id": "i-controller", "groups": ["sg-mine"]},
            {
                "id": "i-agent",
                "groups": ["sg-mine"],
                "agent": True,
                "deployed_from": "i-controller",
            },
            {
                "id": "i-other-agent",
                "groups": ["sg-mine"],
                "agent": True,
                "deployed_from": "i-someone-else",
            },
        ],
    )

    plan = aws_provision.removal_plan(ec2, "abc123", ["i-controller"])

    # The group isn't provisioning's, so only the tag finds the agent machine.
    assert plan["agent_ids"] == ["i-agent"]
    assert plan["group_ids"] == []
    assert plan["tags"]["i-agent"] == (
        "CreatedBy=EC2 Fast Launch, canyonos-deployed-from=i-controller"
    )


def test_a_key_pair_another_machine_uses_is_kept():
    ec2 = _fake_ec2(
        keys=["canyonos-abc123"],
        machines=[
            {"id": "i-controller", "key": "canyonos-abc123"},
            {"id": "i-second-controller", "key": "canyonos-abc123"},
        ],
    )

    plan = aws_provision.removal_plan(ec2, "abc123", ["i-controller"])

    assert plan["key_names"] == []
    assert plan["kept"] == {"key pair canyonos-abc123": ["i-second-controller"]}


def test_a_shared_group_is_kept_with_the_agents_in_it():
    # The agents may be the other machine's, so they aren't terminated either.
    ec2 = _fake_ec2(
        groups=["sg-1"],
        machines=[
            {"id": "i-controller", "groups": ["sg-1"]},
            {"id": "i-second-controller", "groups": ["sg-1"]},
            {"id": "i-agent", "groups": ["sg-1"], "agent": True},
        ],
    )

    plan = aws_provision.removal_plan(ec2, "abc123", ["i-controller"])

    assert plan["group_ids"] == [] and plan["agent_ids"] == []
    assert plan["kept"] == {"security group sg-1": ["i-second-controller"]}


def test_removal_terminates_first_then_deletes_the_group_and_key(tmp_path, monkeypatch):
    monkeypatch.setattr(aws_provision.time, "sleep", lambda _: None)
    (tmp_path / "canyonos-abc123.pem").write_text("KEY")
    ec2 = MagicMock()
    # The terminated machine's network interface still holds the group at first.
    ec2.delete_security_group.side_effect = [
        _client_error("DependencyViolation"),
        None,
    ]
    plan = {
        "machine_ids": ["i-controller"],
        "agent_ids": ["i-agent"],
        "group_ids": ["sg-1"],
        "key_names": ["canyonos-abc123"],
    }

    removed = aws_provision.remove_resources(ec2, plan, ssh_dir=tmp_path)

    calls = [name for name, *_ in ec2.mock_calls if not name.startswith("get_waiter")]
    assert calls == [
        "terminate_instances",
        "delete_security_group",
        "delete_security_group",
        "delete_key_pair",
    ]
    ec2.terminate_instances.assert_called_once_with(
        InstanceIds=["i-controller", "i-agent"]
    )
    assert not (tmp_path / "canyonos-abc123.pem").exists()
    assert f"private key {tmp_path / 'canyonos-abc123.pem'}" in removed


def test_a_group_that_stays_in_use_stops_the_removal(monkeypatch):
    monkeypatch.setattr(aws_provision.time, "sleep", lambda _: None)
    ec2 = MagicMock()
    ec2.delete_security_group.side_effect = _client_error("DependencyViolation")
    plan = {
        "machine_ids": [],
        "agent_ids": [],
        "group_ids": ["sg-1"],
        "key_names": [],
        "kept": {},
    }

    with pytest.raises(ClientError):
        aws_provision.remove_resources(ec2, plan, group_release_seconds=0)


def test_a_run_that_created_nothing_removes_nothing():
    run = aws_provision._AwsProvision()
    run.ec2 = _fake_ec2()

    run.rollback()

    run.ec2.terminate_instances.assert_not_called()
    run.ec2.delete_security_group.assert_not_called()


def _failed_run(tmp_path, monkeypatch, answer):
    """A run that created a machine, a group and a key pair, where `answer` is what the
    key pair question gets: a value, or an exception for Esc or Ctrl+C."""
    monkeypatch.setattr(aws_provision.Path, "home", lambda: tmp_path)

    def pick(entries, title):
        if isinstance(answer, BaseException):
            raise answer
        return answer

    monkeypatch.setattr(aws_provision, "_pick", pick)
    run = aws_provision._AwsProvision()
    run.ec2 = _fake_ec2(groups=["sg-1"], keys=[f"canyonos-{run.provision_id}"])
    run.machine_id = "i-controller"
    return run


def test_a_failed_run_removes_its_key_pair_only_when_told_to(tmp_path, monkeypatch):
    run = _failed_run(tmp_path, monkeypatch, True)

    run.rollback()

    run.ec2.terminate_instances.assert_called_once_with(InstanceIds=["i-controller"])
    run.ec2.delete_security_group.assert_called_once_with(GroupId="sg-1")
    run.ec2.delete_key_pair.assert_called_once_with(
        KeyName=f"canyonos-{run.provision_id}"
    )


@pytest.mark.parametrize(
    "answer", [False, aws_provision._Cancelled(), KeyboardInterrupt()]
)
def test_a_failed_run_keeps_its_key_pair_unless_told_otherwise(
    tmp_path, monkeypatch, answer
):
    (tmp_path / ".ssh").mkdir()
    run = _failed_run(tmp_path, monkeypatch, answer)
    key_file = tmp_path / ".ssh" / f"canyonos-{run.provision_id}.pem"
    key_file.write_text("KEY")

    run.rollback()

    run.ec2.terminate_instances.assert_called_once()
    run.ec2.delete_key_pair.assert_not_called()
    assert key_file.exists()


def test_provision_offers_aws_and_its_teardown(monkeypatch):
    import canyonos.aws_provision as module

    monkeypatch.setattr(provision, "is_interactive", lambda: True)
    monkeypatch.setattr(
        provision, "select_menu", lambda options, title: provision.TEARDOWN_AWS
    )
    monkeypatch.setattr(module, "run_aws_teardown", lambda: "torn down")
    monkeypatch.setattr(module, "run_aws_provision", lambda: "launched")

    assert [value for value, _ in provision.MENU] == [
        provision.AWS,
        provision.TEARDOWN_AWS,
    ]
    assert provision.run_provision() == "torn down"


def test_teardown_with_no_provision_machines_removes_nothing(monkeypatch):
    run = aws_provision._AwsProvision()
    session = MagicMock()
    session.client.return_value = _fake_ec2()
    monkeypatch.setattr(run, "_sign_in", lambda: session)
    monkeypatch.setattr(run, "_choose_region", lambda warn_about_ami: "us-east-1")

    run.teardown()

    session.client.return_value.terminate_instances.assert_not_called()


@pytest.mark.parametrize("remove_key", [True, False])
def test_teardown_asks_before_removing_the_key_pair(tmp_path, monkeypatch, remove_key):
    import datetime

    monkeypatch.setattr(aws_provision.Path, "home", lambda: tmp_path)
    machine = {
        "InstanceId": "i-controller",
        "InstanceType": "t3.large",
        "State": {"Name": "running"},
        "LaunchTime": datetime.datetime(2026, 10, 27, 16, 0),
        "Tags": [{"Key": "canyonos-provision", "Value": "abc123"}],
    }
    # Pick the machine, answer the key pair question, then confirm.
    answers = iter(["i-controller", remove_key, aws_provision.REMOVE])
    monkeypatch.setattr(aws_provision, "_pick", lambda entries, title: next(answers))
    run = aws_provision._AwsProvision()
    run.ec2 = _fake_ec2(groups=["sg-1"], keys=["canyonos-abc123"])

    run._remove([machine])

    run.ec2.terminate_instances.assert_called_once_with(InstanceIds=["i-controller"])
    run.ec2.delete_security_group.assert_called_once_with(GroupId="sg-1")
    assert run.ec2.delete_key_pair.called is remove_key


def test_teardown_shows_the_tags_that_mark_what_it_removes(tmp_path, monkeypatch):
    import datetime

    monkeypatch.setattr(aws_provision.Path, "home", lambda: tmp_path)
    tags = [
        {"Key": "CreatedBy", "Value": "canyonos provision"},
        {"Key": "canyonos-provision", "Value": "abc123"},
    ]
    machine = {
        "InstanceId": "i-controller",
        "InstanceType": "t3.large",
        "State": {"Name": "running"},
        "LaunchTime": datetime.datetime(2026, 10, 27, 16, 0),
        "Tags": tags,
    }
    menus = []

    def pick(entries, title):
        menus.append(entries)
        return entries[0][0]

    said = []
    monkeypatch.setattr(aws_provision, "_pick", pick)
    monkeypatch.setattr(aws_provision.ui, "say", said.append)
    run = aws_provision._AwsProvision()
    run.ec2 = _fake_ec2(groups=["sg-1"])

    run._remove([machine])

    marked = "CreatedBy=canyonos provision, canyonos-provision=abc123"
    assert marked in menus[0][0][2]
    assert f"  Global Controller machine i-controller  ({marked})" in said
    assert f"  security group sg-1  ({marked})" in said


@pytest.mark.parametrize("old_tag", ["canyonos-install", "canyonos-setup"])
def test_teardown_still_finds_machines_from_older_names(tmp_path, monkeypatch, old_tag):
    import datetime

    monkeypatch.setattr(aws_provision.Path, "home", lambda: tmp_path)
    machine = {
        "InstanceId": "i-old",
        "InstanceType": "t3.micro",
        "State": {"Name": "running"},
        "LaunchTime": datetime.datetime(2026, 10, 27, 16, 0),
        "Tags": [{"Key": old_tag, "Value": "old123"}],
    }
    answers = iter(["i-old", aws_provision.REMOVE])
    monkeypatch.setattr(aws_provision, "_pick", lambda entries, title: next(answers))
    run = aws_provision._AwsProvision()
    run.ec2 = _fake_ec2(
        groups=["sg-old"], machines=[{"id": "i-old", "groups": ["sg-old"]}]
    )

    run._remove([machine])

    run.ec2.describe_security_groups.assert_called_once_with(
        Filters=[{"Name": f"tag:{old_tag}", "Values": ["old123"]}]
    )
    run.ec2.delete_security_group.assert_called_once_with(GroupId="sg-old")


def test_teardown_picks_a_global_controller_machine_and_counts_its_agents(
    tmp_path, monkeypatch
):
    import datetime

    monkeypatch.setattr(aws_provision.Path, "home", lambda: tmp_path)
    machines = [
        {
            "InstanceId": machine_id,
            "InstanceType": "t3.large",
            "State": {"Name": "running"},
            "LaunchTime": datetime.datetime(2026, 10, 27, 16, 0),
            "Tags": [{"Key": "canyonos-provision", "Value": "abc123"}],
        }
        for machine_id in ("i-one", "i-two")
    ]
    menus = []

    def pick(entries, title):
        menus.append((title, entries))
        return entries[0][0]

    monkeypatch.setattr(aws_provision, "_pick", pick)
    monkeypatch.setattr(aws_provision.ui, "say", lambda _line: None)
    run = aws_provision._AwsProvision()
    run.ec2 = _fake_ec2(
        machines=[
            {"id": "i-a1", "agent": True, "deployed_from": "i-one"},
            {"id": "i-a2", "agent": True, "deployed_from": "i-one"},
        ]
    )

    run._remove(machines)

    title, entries = menus[0]
    assert title.startswith("Which Global Controller machine should be removed?")
    assert "2 agent machines" in entries[0][2]
    assert "no agent machines" in entries[1][2]
    run.ec2.terminate_instances.assert_called_once_with(
        InstanceIds=["i-one", "i-a1", "i-a2"]
    )
