import pytest

from canyonos import upgrade


@pytest.fixture(autouse=True)
def _version_check_stays_local(monkeypatch, tmp_path):
    """Every command run through `cli.main` checks the supported CLI versions first;
    keep that check off the network and out of the real `~/.canyonos`."""
    monkeypatch.setattr(upgrade, "CACHE_PATH", tmp_path / "supported-versions.json")
    # Port 9 (discard) refuses at once, so a stray check costs nothing.
    monkeypatch.setattr(upgrade, "POLICY_URL", "http://127.0.0.1:9/")
