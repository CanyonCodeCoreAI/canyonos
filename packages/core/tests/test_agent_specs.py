from pathlib import Path

import yaml

from canyonos_core.controller.utils.agent_specs import write_agent_specs


class _Redis:
    def __init__(self):
        self.written = {}

    def hset_multiple(self, key, mapping):
        self.written[key] = mapping


def test_env_references_in_the_manifest_are_expanded_before_keys_are_written(
    tmp_path, monkeypatch
):
    config_dir = Path(tmp_path, "config")
    config_dir.mkdir()
    Path(tmp_path, ".env").write_text("SPECS_AGENT_NAME=Hello\n")
    config_path = config_dir / "global_controller.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {"agents": [{"name": "${SPECS_AGENT_NAME}", "entrypoint": "hello.py"}]}
        )
    )
    monkeypatch.delenv("SPECS_AGENT_NAME", raising=False)
    redis = _Redis()

    write_agent_specs(str(config_path), redis)

    assert list(redis.written) == ["agent:Hello:"]
