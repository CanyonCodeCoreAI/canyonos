# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The CLI rewrites the user's global_controller.yaml in place (resources, config,
test): on every OS that changes only what changed, line endings and UTF-8 included."""

import codecs

import pytest

from canyonos import test as test_cmd
from canyonos.constants import round_trip_yaml, write_config

CONFIG = "# Gestión de agentes\nagents:\n  - name: Alpha\n    replicas: 1\n"


def _rewrite(path, replicas):
    yaml_rt = round_trip_yaml()
    with open(path, encoding="utf-8") as f:
        data = yaml_rt.load(f)
    data["agents"][0]["replicas"] = replicas
    write_config(path, data, yaml_rt)


@pytest.mark.parametrize("ending", ["\n", "\r\n"])
@pytest.mark.parametrize("bom", [b"", codecs.BOM_UTF8])
def test_a_rewrite_keeps_the_files_line_endings_and_byte_order_mark(
    tmp_path, ending, bom
):
    path = tmp_path / "global_controller.yaml"
    path.write_bytes(bom + CONFIG.replace("\n", ending).encode("utf-8"))

    _rewrite(path, 3)

    expected = CONFIG.replace("replicas: 1", "replicas: 3").replace("\n", ending)
    assert path.read_bytes() == bom + expected.encode("utf-8")


def test_canyonos_test_puts_the_config_back_byte_for_byte(tmp_path):
    path = tmp_path / "global_controller.yaml"
    original = CONFIG.replace("\n", "\r\n").encode("utf-8")
    path.write_bytes(original)

    saved = test_cmd._force_local_providers(str(path))
    assert path.read_bytes() == original + b"provider: local\r\n"

    with open(path, "wb") as f:
        f.write(saved)
    assert path.read_bytes() == original
