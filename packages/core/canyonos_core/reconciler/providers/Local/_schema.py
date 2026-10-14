"""What `global_controller.yaml` may set for local: the per-agent keys that place a replica."""

SECTION = None
SECTION_KEYS = {}
RETIRED_KEYS = {}
AGENT_KEYS = {
    "host": (str, False),
    "port": ("port", False),
    "host_port": ("port", False),
    "user": (str, False),
}
