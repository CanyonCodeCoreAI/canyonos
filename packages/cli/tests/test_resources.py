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

    assert config.read_text() == """\
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


def test_a_cancelled_picker_leaves_the_file_untouched(config, monkeypatch):
    monkeypatch.setattr(resources.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(resources, "_pick", lambda _agents: False)

    assert resources.configure_resources(str(config)) is False
    assert config.read_text() == CONFIG


def test_edits_from_the_picker_are_saved(config, monkeypatch):
    def pick(agents):
        resources._set(agents[1], "cpu", resources._cast("cpu", "0.5"))
        resources._set(agents[1], "replicas", resources._cast("replicas", "2"))
        return True

    monkeypatch.setattr(resources.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(resources, "_pick", pick)

    resources.configure_resources(str(config))

    text = config.read_text()
    assert "cpu: 0.5" in text
    assert "replicas: 2" in text


def test_a_missing_config_is_left_to_the_deploy_to_report(tmp_path):
    assert resources.configure_resources(str(tmp_path / "nope.yaml")) is True
