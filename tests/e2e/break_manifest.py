"""Break a copied port's manifest so `canyonos validate` has to reject it.

`rename` gives the first agent's first function a name its class does not
have; `drop` removes that agent's `functions`. Prints the text the finding
has to contain.

Usage: break_manifest.py <.car> rename|drop
"""

import sys
from pathlib import Path

import yaml

car, mode = sys.argv[1:]
path = Path(car) / "config" / "global_controller.yaml"
manifest = yaml.safe_load(path.read_text())
index, agent = next(
    (i, service)
    for i, service in enumerate(manifest["agents"])
    if service.get("type", "agent") == "agent"
)
if mode == "rename":
    function = agent["functions"][0]
    function["name"] += "_missing"
    print(f"`{agent['name']}` has no method `{function['name']}`")
else:
    del agent["functions"]
    print(f"agents[{index}].functions: is required but missing")
path.write_text(yaml.safe_dump(manifest, sort_keys=False))
