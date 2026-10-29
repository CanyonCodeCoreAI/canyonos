# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import pytest

from canyonos import resources

CONFIG = """\
# top comment
agents:
  - name: Sized
    replicas: 3
    resources:
      cpu: 2
      memory: 2048 # keep me
  - name: Bare
    provider: local
"""


@pytest.fixture
def config(tmp_path, monkeypatch):
    path = tmp_path / "global_controller.yaml"
    path.write_text(CONFIG)
    monkeypatch.setattr(resources.sys.stdin, "isatty", lambda: False)
    return path


def test_missing_values_are_filled_and_existing_ones_kept(config):
    assert resources.configure_resources(str(config)) is True

    assert (
        config.read_text()
        == """\
# top comment
agents:
  - name: Sized
    replicas: 3
    resources:
      cpu: 2
      memory: 2048 # keep me
      gpu: 0
  - name: Bare
    provider: local
    resources:
      cpu: 1
      memory: 512
      gpu: 0
    replicas: 1
"""
    )


def test_a_cancelled_picker_leaves_the_file_untouched(config, monkeypatch):
    monkeypatch.setattr(resources.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(resources, "_pick", lambda *_args: False)

    assert resources.configure_resources(str(config)) is False
    assert config.read_text() == CONFIG


def test_edits_from_the_picker_are_saved(config, monkeypatch):
    def pick(agents, *_args):
        resources._set(agents[1], "cpu", resources._cast("cpu", "0.5"))
        resources._set(agents[1], "replicas", resources._cast("replicas", "2"))
        return True

    monkeypatch.setattr(resources.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(resources, "_pick", pick)

    resources.configure_resources(str(config))

    text = config.read_text()
    assert "cpu: 0.5" in text
    assert "replicas: 2" in text


def test_ec2_assign_shows_each_agents_machine_type(tmp_path, monkeypatch):
    path = tmp_path / "global_controller.yaml"
    path.write_text(
        CONFIG
        + """\
provider: ec2-assign
ec2-assign:
  machine_type:
    Sized: t3.micro
"""
    )
    shown = {}

    def pick(agents, machine_types, _pool):
        top, rows, _bottom = resources._table(agents, machine_types)
        shown.update(top=top, rows=rows)
        return True

    monkeypatch.setattr(resources.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(resources, "_pick", pick)

    assert resources.configure_resources(str(path)) is True
    assert " machine " in shown["top"]
    assert shown["rows"][0].rstrip(" │").endswith("t3.micro")
    # An agent the section leaves out shows as unknown, for the deploy's schema check to report.
    assert shown["rows"][1].rstrip(" │").endswith("?")


def test_ec2_pool_lists_its_machines(tmp_path, monkeypatch):
    path = tmp_path / "global_controller.yaml"
    path.write_text(
        CONFIG
        + """\
provider: ec2-pool
ec2-pool:
  machine_type:
    t3.large: 2
    m5.xlarge: 1
"""
    )
    shown = {}

    def pick(agents, machine_types, pool):
        shown.update(machine_types=machine_types, pool=resources._pool_table(pool))
        return True

    monkeypatch.setattr(resources.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(resources, "_pick", pick)

    assert resources.configure_resources(str(path)) is True
    assert shown["machine_types"] is None
    top, rows, _bottom = shown["pool"]
    assert top.startswith("╭ machine ")
    assert [row.split("│")[1:3] for row in rows] == [
        [" t3.large  ", " 2     "],
        [" m5.xlarge ", " 1     "],
    ]


def test_other_providers_show_no_machine_column(config):
    assert resources._machine_types({"provider": "ec2-pool"}) is None
    assert resources._pool({"provider": "ec2-assign"}) is None
    top, _rows, _bottom = resources._table(
        [{"name": "A", "replicas": 1, "resources": {"cpu": 1, "memory": 512, "gpu": 0}}]
    )
    assert "machine" not in top


@pytest.mark.parametrize(
    "field, raw, expected",
    [
        ("cpu", "0.5", 0.5),
        ("cpu", "2", 2),
        ("gpu", "2", 2),
        ("memory", "1024", 1024),
        ("replicas", "3", 3),
    ],
)
def test_valid_values_are_cast(field, raw, expected):
    assert resources._cast(field, raw) == expected


@pytest.mark.parametrize(
    "field, raw",
    [
        ("memory", "1.5"),
        ("replicas", "abc"),
        ("cpu", "abc"),
        ("gpu", "inf"),
        ("gpu", "1.5"),
        ("gpu", "-1"),
        ("cpu", "-0.5"),
    ],
)
def test_invalid_values_raise(field, raw):
    with pytest.raises(ValueError):
        resources._cast(field, raw)
