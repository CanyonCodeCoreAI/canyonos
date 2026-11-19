# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Types of the CanyonOS API's /v1 routes, in `models.py`.

`bun run sdk:generate` writes `models.py` from packages/api/openapi.json; CI fails when
it differs from what is checked in. It imports `typing_extensions`, which the CLI does
not install, so import it only under `typing.TYPE_CHECKING`.
"""
