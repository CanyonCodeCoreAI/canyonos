"""Read agent runtime instance records out of Redis; reads only, shared by both processes."""


def instance_id(provider, agent_name, replica_index):
    return f"{provider}:{agent_name}:{replica_index}"


def instance_key(provider, agent_name, replica_index):
    return f"agent_instance:{instance_id(provider, agent_name, replica_index)}"


def instance_id_from_record(instance):
    return instance_id(
        instance["provider"], instance["agent_name"], int(instance["replica_index"])
    )


def list_instances(redis_client, agent_name=None):
    """Instance records straight from Redis."""
    if agent_name:
        instance_ids = sorted(redis_client.smembers(f"agent:{agent_name}:instances"))
        keys = [f"agent_instance:{instance_id}" for instance_id in instance_ids]
    else:
        keys = sorted(redis_client.scan_keys("agent_instance:*"))

    # Skips port reservations whose runtime hasn't been provisioned yet.
    return [
        instance
        for key in keys
        if (instance := redis_client.hgetall(key)).get("runtime_id")
    ]
