"""Publish the configured agent specs to Redis and read them back in the reconciler."""

import json

# A JSON list of names, not a set: an empty list still exists, so it reads as [] not None.
ACTIVE_AGENTS_KEY = "agents:active"


def spec_key(agent_name):
    return f"agent:{agent_name}:spec"


def _published_names(redis_client):
    raw = redis_client.get(ACTIVE_AGENTS_KEY)
    return None if raw is None else json.loads(raw)


def write_config_specs(agents, redis_client):
    """Publish each agent's spec to Redis, writing the agent list last."""
    for agent in agents:
        name = agent["name"]
        resources = agent.get("resources", {})
        replicas = agent.get("replicas", 1)
        spec_class = "WorkflowSpec" if agent.get("type") == "workflow" else "AgentSpec"
        redis_client.hset_multiple(
            f"agent:{name}:",
            {
                "class": spec_class,
                "api_port": json.dumps(agent.get("api_port", 8080)),
                "resources": json.dumps(resources),
                "replicas": json.dumps(replicas),
                "stateful": json.dumps(agent.get("stateful", False)),
                "redis_port": str(agent.get("redis_port", 6379)),
                "provider": agent.get("provider", "local"),
            },
        )
        redis_client.hset_multiple(
            f"agent:{name}:resources",
            {
                "cpu": str(resources.get("cpu", 1)),
                "memory": str(resources.get("memory", 512)),
                "replicas": json.dumps(replicas),
            },
        )
        # Already env-expanded, so the reconciler never re-parses the YAML.
        redis_client.set(spec_key(name), json.dumps(agent))

    names = [agent["name"] for agent in agents]
    stale = set(_published_names(redis_client) or []) - set(names)
    redis_client.set(ACTIVE_AGENTS_KEY, json.dumps(names))
    # Deleted only once the list no longer names them.
    if stale:
        redis_client.delete(*(spec_key(name) for name in stale))


def read_config_specs(redis_client):
    """Every published agent spec, or None when nothing has published them yet."""
    names = _published_names(redis_client)
    if names is None:
        return None
    if not names:
        return []

    specs = []
    for name in names:
        raw = redis_client.get(spec_key(name))
        if raw is None:
            continue
        specs.append(json.loads(raw))
    return specs or None
