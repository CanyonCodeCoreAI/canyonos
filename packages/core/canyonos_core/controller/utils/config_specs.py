import json

ACTIVE_AGENTS_KEY = "agents:active"


def spec_key(agent_name):
    return f"agent:{agent_name}:spec"


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
    stale = set(redis_client.smembers(ACTIVE_AGENTS_KEY)) - set(names)
    if stale:
        redis_client.srem(ACTIVE_AGENTS_KEY, *stale)
        redis_client.delete(*(spec_key(name) for name in stale))
    if names:
        redis_client.sadd(ACTIVE_AGENTS_KEY, *names)


def read_config_specs(redis_client):
    """Every published agent spec, or None when nothing has published them yet."""
    names = redis_client.smembers(ACTIVE_AGENTS_KEY)
    if not names:
        return None

    specs = []
    for name in sorted(names):
        raw = redis_client.get(spec_key(name))
        if raw is None:
            continue
        specs.append(json.loads(raw))
    return specs or None
