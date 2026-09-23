"""The address other services reach an instance on, not the record's `endpoint` field."""

EC2_PROVIDER = "EC2"


def routing_endpoint_for(instance):
    if instance.get("provider", "local").upper() == EC2_PROVIDER:
        return f"{instance['host']}:{instance['host_port']}"
    return f"{instance['runtime_id']}:{instance['container_port']}"
