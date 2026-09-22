"""Docker container names for agent replicas.

Every place that creates, bootstraps, or cleans up a replica container derives
the name from here, so the provider runtimes and the controller's stale-container
cleanup cannot drift apart.
"""


def container_name(agent_name, replica_index):
    return f"canyonos-{agent_name.lower()}-{replica_index}"


def redis_container_name(host):
    """The single source of truth for this name -- every caller (the controller
    that creates it, and every runtime that points an agent at it) must agree,
    or agents connect to a Redis container that doesn't exist under the name
    they were given."""
    return f"canyonos-redis-{host.replace('.', '-')}"
