# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Write the OpenAPI spec of core's API server to openapi.json."""

import json
import os

# Docker's side shells out to docker on import; both sides serve the same routes.
os.environ["CANYONOS_TARGET"] = "kubernetes"

from canyonos_core.canyonos_api_interface.api_interface import app

spec = app.api_doc
# Core's release version would change the spec on every release; /v1 versions the API.
spec["info"]["version"] = "1"
with open("openapi.json", "w", encoding="utf-8") as f:
    json.dump(spec, f, indent=2)
