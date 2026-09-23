from canyonos.init import SUPPORTED_CORE_CONTRACTS
from canyonos_core import CONTRACT_VERSION


def test_cli_supports_core_contract():
    assert CONTRACT_VERSION in SUPPORTED_CORE_CONTRACTS
