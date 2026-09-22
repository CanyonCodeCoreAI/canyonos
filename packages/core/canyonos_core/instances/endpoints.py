"""The address other services reach an instance on, not the record's `endpoint` field."""

EC2_PROVIDER = "EC2"


def routing_endpoint_for(instance):
    container_port = instance["container_port"]
    if instance.get("provider", "local").upper() == EC2_PROVIDER:
        return f"{instance['host']}:{container_port}"
    return f"{instance['runtime_id']}:{container_port}"
