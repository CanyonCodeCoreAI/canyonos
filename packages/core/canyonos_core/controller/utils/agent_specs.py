import json

import yaml


def write_agent_specs(config_path, redis_client, redis_ports=None):
    with open(config_path, "r") as f:
        config = yaml.safe_load(f) or {}

    redis_ports = redis_ports or {}
    for agent in config.get("agents", []):
        name = agent["name"]
        spec_class = "WorkflowSpec" if agent.get("type") == "workflow" else "AgentSpec"
        redis_port = redis_ports.get(
            agent.get("host", "localhost"), agent.get("redis_port", 6379)
        )
        redis_client.hset_multiple(
            f"agent:{name}:",
            {
                "class": spec_class,
                "api_port": json.dumps(agent.get("api_port", 8080)),
                "resources": json.dumps(agent.get("resources", {})),
                "replicas": json.dumps(agent.get("replicas", 1)),
                "stateful": json.dumps(agent.get("stateful", False)),
                "redis_port": str(redis_port),
                "provider": agent.get("provider", "local"),
            },
        )
