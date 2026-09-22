"""
Read agent runtime instance records out of Redis.

Shared by both processes, and reads only -- creating and destroying instances
lives on canyonos_core/reconciler/provisioner.py.
"""


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
        return [
            instance
            for instance_id in instance_ids
            if (instance := redis_client.hgetall(f"agent_instance:{instance_id}"))
        ]

    return [
        instance
        for key in sorted(redis_client.scan_keys("agent_instance:*"))
        if (instance := redis_client.hgetall(key))
    ]
