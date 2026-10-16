# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import shutil

import pytest

from cli_usage_stack import UsageStack


@pytest.fixture(scope="session")
def usage_stack():
    """The real usage API and its DynamoDB Local for the whole run, removed at the end."""
    missing = [tool for tool in ("docker", "bun") if shutil.which(tool) is None]
    if missing:
        pytest.fail(f"The CLI usage end-to-end tests need {' and '.join(missing)}.")
    stack = UsageStack()
    try:
        stack.start()
        yield stack
    finally:
        stack.remove()
