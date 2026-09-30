# EC2 deployment

Any service entry can run on EC2 instead of the local Docker engine. Set
`provider: EC2` on the entry and give it an `instance_type`. Then add an
`ec2:` block at the top of the manifest. The provider value is accepted in
any casing.

## Configuration

```yaml
ec2:
  region: us-east-1
  subnet_id: subnet-0123456789abcdef0
  security_group_ids:
    - sg-0123456789abcdef0

agents:
  - name: ExampleAgent
    entrypoint: agents/example_agent.py
    provider: EC2
    instance_type: t3.micro
```

Required: `region`, `subnet_id`, `security_group_ids`, and `instance_type` on
each EC2 entry. There is no default for these.

Optional, with defaults:

| Key | Default |
|---|---|
| `ami_id` | CanyonOS's own Ubuntu AMI in `us-east-1`. Any AMI with Docker and `zstd` works. |
| `ssh_user` | `ubuntu` |
| `ssh_private_key_path` | `~/.ssh/canyonos_ec2`. If nothing is there, CanyonOS generates an ed25519 key on first use. A path you set yourself must already exist. |
| `instance_profile_name` | none. Attaches an IAM role to each instance; the deploying identity then needs `iam:PassRole`. |
| `public_ip_timeout` | `120` seconds |
| `controller_health_timeout` | `180` seconds |

Whichever key is used is imported into AWS on first use as
`canyonos-ec2-<project_id>-<hash>`, so the AMI does not need it
pre-authorised.

## What the deploying machine needs

The machine running `canyonos deploy` needs Docker, AWS credentials with
`ec2:RunInstances`, `ec2:TerminateInstances`, `ec2:DescribeInstances`,
`ec2:CreateTags` and `ec2:ImportKeyPair`, and a route to the instances'
private IPs, which in practice means running inside the same VPC as
`subnet_id`. The security group has to allow 22, 50051 and 6379 from itself
and the workflow and dashboard ports (8080 and 8081 by default) from whoever
calls the workflow. The EC2 provider README in `packages/core` has the exact
IAM policy JSON.

Before provisioning, `canyonos deploy` checks the manifest schema, that the
local Docker engine is reachable, and that the generated gRPC modules import.
It does not check AWS credentials, the SSH key, the subnet or the security
group. Those fail during provisioning.

## Networking

Each EC2 host runs its own Redis and its own containers. Inside a container
there, `host.docker.internal` is that EC2 host, not your machine. Services
find each other through the routing table, which publishes each instance's
private IP and port. A database or other backing service your code reaches by
address has to be reachable from every host that runs a caller.

`otel.destinations` are read by the Global Controller's exporter only, on the
machine that ran `canyonos deploy`. They do not need to be reachable from the
EC2 hosts.

Every container still runs its own LLM gateway on `127.0.0.1:8081`, and the
same six base-URL variables are injected. See [LLM gateway](LLM_GATEWAY.md).

## The env file on a remote host

The file `env_file` points at is copied over SSH into a private temporary
directory on the EC2 host, passed to `docker run --env-file`, and deleted as
soon as the container has started. An empty file is skipped. Explicit `-e`
values set by the runtime still win over the file, as they do locally.

## Stopping and leftovers

`canyonos deploy` tails the controller log until the workflow is up, then
prints where everything is and stops tailing. Once the log tail is on screen,
Ctrl+C only stops the tail; the deployment keeps running and `canyonos logs`
reattaches. Ctrl+C while the project is still syncing or starting, or a
deploy that fails, tears everything down.

`canyonos stop` asks the controller to drain. Every instance it recorded in
Redis is terminated through the AWS API. The drain waits 30 seconds; whatever
is still going after that is left for the next start to reconcile.

An instance whose container fails to start is terminated automatically. The
one window where an instance can leak is between `RunInstances` and getting a
public IP: if that times out, nothing is recorded and nothing is terminated.
Look for instances tagged `Name=canyonos-<agent>-<replica>` and
`CreatedBy=EC2 Fast Launch` in the region and terminate those specifically.
