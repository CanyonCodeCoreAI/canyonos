# Cloud Provider Logic

Backend implementations for where CanyonOS runs an agent's container. Every agent
in `global_controller.yaml` picks one via `provider: local` or `provider: EC2`.

The providers differ in where each agent container runs: local runs on the deployment host, while EC2 launches a separate EC2 instance.

## Providers

| Provider | Folder | Compute |
| --- | --- | --- |
| `local` (default) | `Local/` | Docker container on the same machine, the root README has the whole flow. |
| `EC2` | `EC2/` | One EC2 instance per replica. |

## Instance addresses

| Address | Used for |
| --- | --- |
| Private IP | Everything CanyonOS does internally |
| Public IP | Querying a workflow from outside AWS |

For EC2, run `canyonos deploy` from inside the same VPC as the instances.

See [EC2/README.md](EC2/README.md) for EC2-specific setup.
