# EC2 deployment

An EC2 deploy runs your agents on EC2 machines that CanyonOS launches, while the rest of
the workflow stays on the machine that runs `canyonos deploy`. You need an AWS account.

| Machine               | What runs on it                                                                            | Lifetime                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| The deploying machine | `canyonos deploy`, the Global Controller, the endpoint and the dashboard                   | Keep it running while the workflow is live. `canyonos provision` creates one |
| Agent machines        | Your agents' replicas, and a Redis of their own that requires the project's Redis password | Launched by `canyonos deploy`, terminated by `canyonos stop`                 |

The top-level `provider` in the workflow config decides how agents get machines:

| `provider`   | Agent machines                                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ec2-assign` | One machine per replica, of the type `ec2-assign.machine_type` gives its agent. A replica never shares its machine                                                                                                                                               |
| `ec2-pool`   | A fixed pool, with as many of each type as `ec2-pool.machine_type` lists. Each replica goes on the least loaded machine, by its agent's `resources`. A pool never refuses a replica: when the `resources` add up to more than the pool has, they share it evenly |

EC2 runs on the `docker` target, so if the workflow points at Kubernetes, run
`canyonos target docker` first; see
[Where a workflow deploys](LOCAL.md#where-a-workflow-deploys).

## Quick start

This deploys the
[Hello World on EC2](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/examples/helloworld-ec2-assign/README.md)
example (`provider: ec2-assign`), sends it a request and removes everything again. The
sections below explain each step.

On your own computer, from the root of the CanyonOS repository:

```bash
canyonos provision                    # choose Provision AWS, then Launch the machine
scp -i ~/.ssh/<key>.pem -r examples/helloworld-ec2-assign ubuntu@<address>:~/
ssh -i ~/.ssh/<key>.pem ubuntu@<address>
```

`<key>` and `<address>` are what `canyonos provision` prints. On the deploying machine:

```bash
cloud-init status --wait              # wait for the install to finish
cd ~/helloworld-ec2-assign
canyonos deploy                       # choose 1. Deploy
curl -X POST http://127.0.0.1:8080/main \
  -H "Content-Type: application/json" -d '{"query": "World"}'
curl http://127.0.0.1:8080/status/<request_id>
canyonos stop                         # terminate the agent machines
```

Back on your own computer:

```bash
canyonos provision                    # choose Tear down AWS
```

## Create the deploying machine

On your own computer, with CanyonOS [installed](../INSTALLATION.md), run
`canyonos provision` and choose **1. Provision AWS**:

1. **Sign in** with your default AWS credentials (environment variables, `AWS_PROFILE`,
   `~/.aws`, SSO), through `aws login` in your browser when the AWS CLI is installed,
   or by typing an access key and secret. Typed keys are used for this run only.
2. **Choose the region, VPC and subnet.** In a region with no VPC, provisioning can
   create the default one. Subnets with no route to an internet gateway are marked:
   the machine needs internet access to install.
3. **Choose a security group.** A new group lets its machines reach each other on every
   TCP port, and lets your public IP reach SSH (`22`), the endpoint and the dashboard
   (`8080`-`8082`). For an existing group, provisioning lists the rules it lacks and
   asks before adding them.
4. **Choose a machine type.** It builds the agents' images and runs the Global
   Controller. `t3.micro` is the cheapest but tight for building images; `t3.large`
   suits most workflows. Only x86 types work.
5. **Choose or create a key pair** to SSH in with. A new key is saved to
   `~/.ssh/<name>.pem`.
6. **Confirm the IAM role.** `canyonos-controller` is created, or updated, with only the
   permissions deploying needs; see [IAM permissions](#iam-permissions).

Nothing is created in AWS until you choose **Launch the machine** on the summary. Then
provisioning:

- checks that a CanyonOS release matching your CLI exists;
- launches the machine with a public IP, IMDSv2 with a hop limit of `2` and a 30 GiB
  disk (more if the AMI needs it);
- runs a boot script that adds 2 GiB of swap if there is none, installs Docker, Compose
  and `zstd`, and installs your CLI's CanyonOS release, so the machine's CLI and images
  match yours;
- prints the commands to copy a workflow over and sign in.

If a run fails, or you back out after confirming, provisioning removes what that run
created. It keeps the `canyonos-controller` role and any default VPC it made, which are
free and reused next time, and asks before removing a key pair it created.

Agent machines launch into the deploying machine's region, subnet and security group,
so the workflow config only needs their machine types. Outside `us-east-1`, they also
need `ami_id`, and provisioning warns about it; see [Configuration](#configuration).
From a development checkout, see
[Run a checkout on an EC2 machine](../contributing/DEVELOPMENT.md#run-a-checkout-on-an-ec2-machine).

## Deploy a workflow

These steps use Hello World on EC2: `Workflow` takes the request and calls `HelloAgent`
for a greeting. With one replica each, CanyonOS launches two `t3.micro` agent machines.
It needs no LLM keys, but EC2 charges apply. Your own workflow deploys the same way.

### 1. Copy the workflow to the deploying machine

From the root of the CanyonOS repository, with the key and address `canyonos provision`
printed:

```bash
scp -i ~/.ssh/<key>.pem -r examples/helloworld-ec2-assign ubuntu@<address>:~/
ssh -i ~/.ssh/<key>.pem ubuntu@<address>
```

On the deploying machine, wait for the install, check Docker, and stay in the workflow
folder for the remaining steps:

```bash
cloud-init status --wait
canyonos doctor
cd ~/helloworld-ec2-assign
```

### 2. Choose how agents get machines

Set `provider` and its section in the workflow config. `machine_type` is the only
required key.

<div class="tabs" markdown>

<div class="tab" data-label="ec2-assign" markdown>

Each replica gets a machine of its own. `machine_type` gives every agent its EC2
machine type, and must list every agent. Hello World already has:

```yaml
provider: ec2-assign

ec2-assign:
  machine_type:
    HelloAgent: t3.micro
    Workflow: t3.micro
```

</div>

<div class="tab" data-label="ec2-pool" markdown>

Every replica shares a pool of machines. `machine_type` maps each EC2 machine type to
how many of it to start:

```yaml
provider: ec2-pool

ec2-pool:
  machine_type:
    t3.micro: 1
```

</div>

</div>

### 3. Test locally, then deploy

```bash
canyonos test "World"     # with nothing deployed: runs on this machine's Docker, no AWS
canyonos deploy           # choose 1. Deploy
```

The deploy shows each agent's CPU, memory, GPU and replicas, with its machine type or
the pool. It then launches the agent machines, copies the images to them, starts Redis
on each and places the replicas. **Deploy is live** prints the endpoint and dashboard
addresses on the machine's public IP; `canyonos status` shows them again.

The deploy checks the workflow and the local Docker first, but not AWS: problems with
credentials, SSH, the subnet or security groups show up while the agent machines start.
A deploy that fails before the workflow is up removes what it started, agent machines
included. Ctrl+C behaves as in a [local deploy](LOCAL.md#deploy).

### 4. Send a request

On the deploying machine, with the port the deploy printed (`8080` unless it was taken):

```bash
curl -X POST http://127.0.0.1:8080/main \
  -H "Content-Type: application/json" -d '{"query": "World"}'
curl http://127.0.0.1:8080/status/<request_id>    # the request_id the first call returned
```

When `status` is `done`, `result` is `{"greeting": "Hello, World! I'm the HelloAgent!"}`.
From your own computer, use the deploying machine's public address instead of
`127.0.0.1`; a security group made by `canyonos provision` already allows your IP on
`8080`-`8082`.

### 5. Stop

```bash
canyonos stop
```

CanyonOS drains the replicas for up to 180 seconds, then terminates every agent machine
it launched; the whole stop waits up to four minutes. The deploying machine keeps
running; see [Tear down the deploying machine](#tear-down-the-deploying-machine).

Every agent machine bills from deploy to stop, replicas or not, so check the EC2 console
that they terminated. If the stop ran out of time, find the leftovers in the region by
their tags, `CreatedBy=EC2 Fast Launch` and
`Name=canyonos-<first 8 characters of the launch ID>`, and terminate them after
confirming they are yours.

## Tear down the deploying machine

Run `canyonos stop` on the deploying machine first, so its agent machines drain and
terminate cleanly. Then, on your own computer, run `canyonos provision`, choose
**2. Tear down AWS**, sign in, pick the region and pick the Global Controller machine
(the deploying machine). Each machine is listed with how many agent machines it runs,
since those go with it.

Teardown lists what it will delete before deleting anything:

| What                                             | Deleted when                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| The Global Controller machine                    | Always                                                                                                                           |
| Its security group                               | Provisioning created it, and no other running machine uses it                                                                    |
| The key pair, and its private key under `~/.ssh` | Provisioning created it, no other running machine uses it, and you say yes                                                       |
| Agent machines still running                     | They carry its `canyonos-deployed-from=<machine ID>` tag, or run in a security group provisioning created for it that is deleted |

Teardown only deletes resources tagged with that machine's provision ID
(`CreatedBy=canyonos provision`, `canyonos-provision=<provision ID>`). A security group
or key pair you chose yourself is kept, and so is the `canyonos-controller` role:
delete it in the IAM console once nothing uses it. Keep a key pair you've used anywhere
AWS can't see, such as GitHub.

## Configuration

`ec2-pool:` and `ec2-assign:` take the same keys. Only `machine_type` differs: for
`ec2-pool` it maps each machine type to a count, and for `ec2-assign` it maps every
agent to a machine type.

```yaml
provider: ec2-pool

ec2-pool:
  region: us-east-1
  machine_type:
    t3.micro: 2
    t3.large: 1
  subnet_id: subnet-0123456789abcdef0
  security_group_ids:
    - sg-0123456789abcdef0
```

| Setting                     | Default                                 | What it does                                                                               |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `machine_type`              | None, required                          | The pool (`{t3.micro: 2}`) or each agent's type (`{HelloAgent: t3.micro}`). x86 types only |
| `market_type`               | `on-demand`                             | `spot` requests spot machines, for every machine                                           |
| `region`                    | The deploying machine's region          | Where agent machines launch                                                                |
| `subnet_id`                 | The deploying machine's subnet          | Must be able to give each machine a public IP                                              |
| `security_group_ids`        | The deploying machine's security groups | The groups every agent machine joins                                                       |
| `ami_id`                    | CanyonOS Ubuntu AMI                     | The default exists only in `us-east-1`                                                     |
| `ssh_user`                  | `ubuntu`                                | Must match the AMI                                                                         |
| `iam_profile_name`          | None                                    | IAM instance profile attached to agent machines                                            |
| `public_ip_timeout`         | `120` seconds                           | How long to wait for a machine's public IP                                                 |
| `controller_health_timeout` | `180` seconds                           | How long to wait for a replica on the machine to become healthy                            |

`region`, `subnet_id` and `security_group_ids` are read from the deploying machine's EC2
metadata. Set them when you deploy from a machine that is not on EC2, where a deploy
without them fails when the first agent machine launches, or to put agents in another
subnet or group.

### SSH key

The top-level `ssh_private_key_path`, outside `ec2-pool:` and `ec2-assign:`, is the key
the Global Controller signs in to agent machines with. CanyonOS imports its public key
into AWS on first use, so the AMI doesn't need it in advance.

- **Default:** `~/.ssh/canyonos_ec2` inside the Global Controller's container, where
  CanyonOS creates an ed25519 key when there is none.
- **A key you set** must already exist, with permissions `600` or `400`. The Global
  Controller sees only its copy of your workflow, so put the key in the workflow folder,
  such as `.ssh/my-key` beside `config/`, and give its path relative to that folder.
  Hidden folders never reach an agent image.

## Set up AWS yourself

`canyonos provision` does all of this. To use a machine you already have, or to check
what it made, here is what the deploying machine and the AWS account need.

### The deploying machine

It reaches agent machines over their private IPs, so in practice it is a Linux EC2
machine in the same VPC as them. It needs:

- the CanyonOS CLI, Docker with Compose, and `zstd`, with Docker usable by your user;
- outbound access to the AWS API, the container image registry and package registries;
- an attached IAM role with the permissions below;
- IMDSv2 with a response hop limit of `2`, so the Global Controller container can read
  the role's credentials; see
  [AWS metadata settings](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html).

The Global Controller calls AWS from inside its container with Boto3's default
credential lookup, so it doesn't see your shell's AWS variables, `AWS_PROFILE` or
`~/.aws`. It uses the attached role, or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
in the workflow's `.env`. Every agent gets `.env` too, so prefer the role.

### IAM permissions

| Who                                             | Needs                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Deploying machine                               | `ec2:RunInstances`, `ec2:TerminateInstances`, `ec2:DescribeInstances`, `ec2:DescribeInstanceTypes`, `ec2:CreateTags`, `ec2:ImportKeyPair` |
| Deploying machine, if `iam_profile_name` is set | `iam:PassRole` on the role being attached                                                                                                 |
| Agent machines                                  | Nothing. Set `iam_profile_name` only if your agents call AWS themselves.                                                                  |

The EC2 provider README has the
[IAM policy JSON](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/reconciler/providers/EC2/README.md#iam-permissions).

### AWS account

- **Subnet:** CanyonOS gives each agent machine a public IP and waits for it, so the
  subnet must be able to give one. Traffic between machines still uses private IPs.
- **AMI:** in `us-east-1`, the default CanyonOS Ubuntu AMI works. In other regions, set
  `ami_id` to an x86 AMI with Docker and `zstd` installed, whose SSH user can run
  `sudo docker` without a password.
- **Quota:** your EC2 quota must cover every agent machine: those in
  `ec2-pool.machine_type`, or one per replica with `ec2-assign`.

### Network rules

Allow these inbound TCP connections in the security groups. Host firewalls and network
ACLs must allow the same traffic and its responses.

| To                | Port                                          | From                                 |
| ----------------- | --------------------------------------------- | ------------------------------------ |
| Agent machines    | `22` (SSH)                                    | Deploying machine                    |
| Agent machines    | `50051`-`50150` (gRPC), `6379` (Redis)        | Deploying machine and agent machines |
| Deploying machine | The endpoint's gRPC port (see below)          | Agent machines                       |
| Deploying machine | Endpoint port: `8080`, else the next free one | Whoever sends requests               |
| Deploying machine | Dashboard port: `8081` by default             | Whoever opens the dashboard          |

If every machine shares one security group, the internal rules can name that group as
their source. Replicas sharing a machine publish gRPC on `50051`, `50052` and up, on the
machine's private IP only; the endpoint publishes its gRPC port on the deploying
machine's private IP.

Agents send results back over the endpoint's gRPC port, so if it's blocked, every
request stays pending. After deploying, find it with:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

and allow the host port mapped to the endpoint container's `50051`: for
`0.0.0.0:50052->50051/tcp`, allow `50052`.

## How agents behave on EC2

- **Machines that go away:** a machine AWS no longer lists as running, such as a
  reclaimed spot machine, is replaced. Its replicas start again on the least loaded
  machines, or on the replacement with `ec2-assign`.
- **Scaling and config changes:** with `ec2-assign`, scaling an agent starts or
  terminates machines along with its replicas. Changing `machine_type` or `market_type`
  and reloading the config starts the machines it adds and terminates the ones it
  drops; their replicas start again on the machines that are kept, and any calls they
  were running fail.
- **Routing:** agents find each other by each replica's private IP and port. A database
  or other system your code connects to must be reachable from every agent machine that
  calls it.
- **`host.docker.internal`:** inside a replica, this is the agent machine it runs on,
  not the deploying machine.
- **`.env`:** each replica gets the workflow's `.env`, as it does locally. It is copied
  over SSH to a private temporary folder on the agent machine and deleted once the
  container starts; see [What `.env` is for](BUILD_ARTIFACT.md#what-env-is-for).
- **LLM Gateway:** each container runs its own gateway, as it does locally; see
  [LLM Gateway](LLM_GATEWAY.md).
- **Machine metrics:** each agent machine runs a metrics collector next to its Redis,
  and the dashboard shows every machine by its private IP. Agent machines run the
  collector from the official image of your CLI's version, so changes to it in a
  development checkout don't reach them; `canyonos deploy` warns when that applies.

If something goes wrong, see [Troubleshooting](TROUBLESHOOTING.md).
