# EC2 deployment

A deployment can run its agents on EC2 machines instead of the local Docker engine.
Two kinds of machine are involved:

- The **deploying machine** runs `canyonos deploy`. It hosts the Global
  Controller, the endpoint, and the dashboard, so keep it running for as long as
  the deployment is live.
- **Agent machines** are the EC2 machines CanyonOS launches when you deploy. Each
  runs its own Redis. The top-level `provider` picks how they are chosen:
  - `ec2-assign`: one machine per replica, of the type the `ec2-assign:` section gives
    its agent. A replica never shares its machine.
  - `ec2-pool`: a pool, as many of each machine type as `ec2-pool.machine_type` lists. Each
    replica goes on the least loaded one, by its `resources`, and a pool smaller
    than the agents' `resources` is shared rather than refused.

`canyonos provision` creates the deploying machine for you. This guide uses it to
deploy the [Hello World on EC2](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/examples/helloworld-ec2-assign/README.md)
example (`provider: ec2-assign`), send it a request, and stop it. To set up AWS by
hand instead, see [Setting up AWS yourself](#setting-up-aws-yourself).

## TL;DR

On your own computer, from this repository's root, run the following to create a canyonOS enabled EC2 machine:

```bash
canyonos provision                    # choose Provision AWS, then Launch the machine
scp -i ~/.ssh/<key>.pem -r examples/helloworld-ec2-assign ubuntu@<address>:~/
ssh -i ~/.ssh/<key>.pem ubuntu@<address>
```

On the deploying machine, run the following to deploy a sample Hello World example using ec2-assign:

```bash
cd ~/helloworld-ec2-assign
canyonos deploy                       # choose 1. Deploy
curl -X POST http://127.0.0.1:8082/main \
  -H "Content-Type: application/json" -d '{"query": "World"}'
curl http://127.0.0.1:8082/status/<request_id>
```

Back on your own computer:

```bash
canyonos provision                    # choose Tear down AWS
```

`<key>` and `<address>` are what `canyonos provision` prints. The sections below
explain each step.

## Create the deploying machine

On your own computer, with the CanyonOS CLI installed, run:

```bash
canyonos provision
```

Choose **Provision AWS**, then:

1. **Sign in.** Use your default AWS credentials (environment variables,
   `AWS_PROFILE`, `~/.aws`, SSO), sign in with your browser through `aws login`
   when the AWS CLI is installed, or type an access key and secret. Keys you type
   are used for this run only and are not saved.
2. **Choose where it runs:** the region, VPC and subnet. A region with no VPC
   can get its default VPC created. Subnets without a route to an internet
   gateway are marked, since the machine needs internet access to install.
3. **Choose a security group.** A new group lets its machines reach each other
   on every TCP port, and lets your current public IP reach SSH (`22`), the API
   and the dashboard (`8080`-`8082`). For an existing group, provisioning lists the
   rules it lacks and asks before adding them.
4. **Choose a machine type.** It builds the agents' images and runs the Global
   Controller. `t3.micro` is cheapest for trying it out, `t3.large` suits most
   workflows. Only x86 types work.
5. **Choose a key pair** to SSH in with, or create one. A new key's private key
   is saved to `~/.ssh/<name>.pem`.
6. **Choose an IAM role.** The `canyonos-controller` role is created, or updated
   if it exists, with only the permissions deploying needs (see
   [IAM permissions](#iam-permissions)).

Provisioning shows a summary and creates nothing in AWS until you choose **Launch the
machine**. The machine gets a public IP, IMDSv2 with a hop limit of `2`, a
30 GiB disk (more if the AMI needs it), and a boot script that installs Docker,
`zstd` and the same CanyonOS release as the CLI you ran `canyonos provision` with, so the
machine's CLI and the images it pulls match yours. Provisioning checks that the release
exists before creating anything. From a development checkout, provisioning can put the
checkout on the machine instead; see
[Development](../contributing/DEVELOPMENT.md#run-a-checkout-on-an-ec2-machine).
Provisioning then prints the commands to copy your project over and SSH in.

If a run fails or you back out after confirming, provisioning removes what that run
created. It keeps the `canyonos-controller` role and any default VPC it made,
since both are free and reused next time, and it asks before removing a key pair
it created.

Agent machines launch into the deploying machine's subnet and security group,
and the same region, so the `ec2-pool:` or `ec2-assign:` section only has to set the
machine types.
Provisioning in a region other than `us-east-1` warns that agents there need
`ec2-pool.ami_id`.

## Deploy Hello World

Hello World has two agents: `Workflow` receives the request and calls
`HelloAgent` to build a greeting. `examples/helloworld` runs them locally;
`examples/helloworld-ec2-assign` is the same example set up for `ec2-assign`, so
with one replica each, CanyonOS launches two `t3.micro` agent machines. It needs no
LLM keys, but EC2 charges apply.

### 1. Copy the example to the deploying machine

Deploying writes to the project's files, so send a copy. From this repository's
root, using the address and key `canyonos provision` printed:

```bash
scp -i ~/.ssh/<key>.pem -r examples/helloworld-ec2-assign ubuntu@<address>:~/
ssh -i ~/.ssh/<key>.pem ubuntu@<address>
```

On the deploying machine, wait for the install to finish and check Docker:

```bash
cloud-init status --wait
canyonos doctor
cd ~/helloworld-ec2-assign
```

Run every remaining command from this folder.

### 2. Check how the agents get machines

`config/global_controller.yaml` already puts each replica on a machine of its own:

```yaml
provider: ec2-assign

ec2-assign:
  machine_type:
    HelloAgent: t3.micro
    Workflow: t3.micro
```

`machine_type` gives every agent its EC2 instance type, and is required. To share a
pool of machines between the agents instead, use:

```yaml
provider: ec2-pool

ec2-pool:
  machine_type:
    t3.micro: 1
```

Here `machine_type` maps each instance type to how many of it to start. The
`provider` value is accepted in any casing.

### 3. Test locally, then deploy

Check the workflow first:

```bash
canyonos test "World"
```

With no deployment running, this runs on the local Docker engine, prints a
greeting, and tears down. It does not touch AWS.

Then deploy to EC2:

```bash
canyonos deploy
```

Choose **1. Deploy** from the menu. CanyonOS launches the agent machines,
copies the images to them, starts Redis on each, and places the replicas. When it
prints **Deploy is live**, it also prints the endpoint and dashboard URLs;
`canyonos status` shows them again.

Before launching anything, `canyonos deploy` checks the manifest, the local
Docker engine, and the generated gRPC modules. It does not check AWS
credentials, SSH, the subnet, or security groups; those errors appear while the
machines are being set up.

Ctrl+C while the project is still syncing or starting, or a failed deploy,
tears everything down. Once the controller log is on screen, Ctrl+C only stops
showing it; the deployment keeps running and `canyonos logs` shows it again.

### 4. Send a request

On the deploying machine:

```bash
curl -X POST http://127.0.0.1:8082/main \
  -H "Content-Type: application/json" \
  -d '{"query": "World"}'
```

The endpoint returns a request ID straight away:

```json
{ "request_id": "<request_id>" }
```

Poll for the result with that ID:

```bash
curl http://127.0.0.1:8082/status/<request_id>
```

When `status` is `done`, `result` contains:

```json
{ "greeting": "Hello, World! I'm the HelloAgent!" }
```

To call the API from your own computer, use the deploying machine's public
address instead of `127.0.0.1`. A security group made by `canyonos provision` already allows
your IP on `8080`-`8082`.

### 5. Stop

From the same project folder:

```bash
canyonos stop
```

CanyonOS drains the replicas (up to 180 seconds), then terminates every agent
machine it launched. The whole stop waits up to four minutes. The deploying
machine keeps running; see [Tear down the deploying machine](#tear-down-the-deploying-machine).

Check the EC2 console to confirm the agent machines terminated. Every machine in
the pool runs, and bills, from deploy to stop, whether or not replicas are on it.
If stop runs out of time, find the leftover machines in the region by their tags,
`CreatedBy=EC2 Fast Launch` and `Name=canyonos-<first 8 characters of the launch ID>`,
and terminate them after confirming they are yours.

## Tear down the deploying machine

Run `canyonos stop` on the deploying machine first, so the agent machines drain
and terminate cleanly. Then, on your own computer:

```bash
canyonos provision
```

Choose **Tear down AWS**, sign in, pick the region, and pick the Global Controller
machine: the deploying machine. Each is listed with how many agent machines it
runs, since those are removed with it. Teardown lists what it will delete before
it does anything:

- the Global Controller machine;
- the security group, if provisioning created it for that machine;
- the key pair and the private key saved under `~/.ssh`, if provisioning created them
  and you choose to remove them;
- the agent machines it deployed that are still running, found by their
  `canyonos-deployed-from=<machine ID>` tag, and any others still running in a
  security group provisioning created for it.

Teardown never deletes a key pair without asking, and only ever offers key pairs
provisioning created. Its private key may be in use somewhere AWS can't see, such as GitHub, so
keep it if you've used it anywhere else. A key pair or security group provisioning
created that another running machine still uses is kept automatically, and so are
the agent machines in a kept group.

Everything `canyonos provision` creates is tagged `CreatedBy=canyonos provision`
and `canyonos-provision=<provision ID>`, and teardown only deletes resources with
that machine's provision ID. A security group or key pair you chose yourself is kept,
and so is the `canyonos-controller` role; delete the role in the IAM console
once nothing uses it.

## Configuration

With `provider: ec2-pool`, list the pool under `ec2-pool.machine_type`: each machine type and
how many of it to start. With `provider: ec2-assign`, the section is `ec2-assign:`
instead, and its `machine_type` gives every agent in `agents` its machine type. The
two sections take the same keys otherwise, and `machine_type` is the only required
one. Any of `region`, `subnet_id` and `security_group_ids` the section leaves out is
read from the deploying machine's EC2 metadata, so they are only needed when you deploy from somewhere
else, or want agents in another subnet or group. Deploying from a machine that
is not on EC2 without them fails when the first agent machine launches.

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

| Setting                         | Default                                 | Notes                                                                               |
| ------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| `ec2-pool.machine_type`              | None, required                          | Each machine type and how many to start, such as `{t3.micro: 2}`                    |
| `ec2-assign.machine_type`         | None, required                          | Each agent's machine type, such as `{HelloAgent: t3.micro}`; every agent is listed  |
| `ec2-pool.market_type`               | `on-demand`                             | `spot` requests spot machines, for every machine                                    |
| `ec2-pool.region`                    | The deploying machine's region          |                                                                                     |
| `ec2-pool.subnet_id`                 | The deploying machine's subnet          | Must allow public IP assignment                                                     |
| `ec2-pool.security_group_ids`        | The deploying machine's security groups |                                                                                     |
| `ec2-pool.ami_id`                    | CanyonOS Ubuntu AMI                     | The default exists only in `us-east-1`                                              |
| `ec2-pool.ssh_user`                  | `ubuntu`                                | Must match the AMI                                                                  |
| `ec2-pool.iam_profile_name`          | None                                    | IAM instance profile attached to agent machines                                     |
| `ec2-pool.public_ip_timeout`         | `120` seconds                           | How long to wait for a machine's public IP                                          |
| `ec2-pool.controller_health_timeout` | `180` seconds                           | How long to wait for a machine's controller to become healthy                       |
| `ssh_private_key_path`          | `~/.ssh/canyonos_ec2`                   | Top-level key, not under `ec2-pool:`; the path is inside the Global Controller container |

If the default key does not exist, CanyonOS generates an ed25519 key there. A
key path you set yourself must already exist inside the Global Controller
container, with permissions `600` or `400`; keys on the host are not mounted in.
Either way, CanyonOS imports the public key into AWS on first use, so the AMI
does not need it in advance.

## Setting up AWS yourself

`canyonos provision` does all of this. To use a machine you already have, or to
check what `canyonos provision` made, the deploying machine and AWS account need the
following.

### The deploying machine

The deploying machine reaches agent machines over their private IPs, so in
practice it is a Linux EC2 machine in the same VPC as the agent machines. It
needs:

- The CanyonOS CLI, Docker with Compose, and `zstd`, with Docker usable by your
  user.
- Outbound access to the AWS API, the container image registry, and package
  registries.
- An attached IAM role with the permissions below.
- IMDSv2 enabled with a response hop limit of `2`, so the Global Controller
  container can read the role's credentials. See
  [AWS metadata settings](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html).

The Global Controller calls AWS from inside its container, using Boto3's
default credential lookup. The attached role is the supported way to give it
credentials. The CLI does not pass in shell AWS variables, `AWS_PROFILE`, or
`~/.aws`.

### IAM permissions

| Who                                                 | Needs                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Deploying machine                                   | `ec2:RunInstances`, `ec2:TerminateInstances`, `ec2:DescribeInstances`, `ec2:DescribeInstanceTypes`, `ec2:CreateTags`, `ec2:ImportKeyPair` |
| Deploying machine, if `ec2-pool.iam_profile_name` is set | `iam:PassRole` on the role being attached                                                                    |
| Agent machines                                      | Nothing. Set `ec2-pool.iam_profile_name` only if your agents call AWS themselves.                                 |

The EC2 provider README has the
[IAM policy JSON](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/reconciler/providers/EC2/README.md#iam-permissions).

### AWS account

- **Subnet:** CanyonOS gives each agent machine a public IP and waits for it, so
  the subnet must allow public IP assignment. All traffic between machines still
  uses private IPs.
- **AMI:** in `us-east-1` the default CanyonOS Ubuntu AMI works. In other
  regions, set `ec2-pool.ami_id` to an AMI with Docker and `zstd` installed, whose SSH
  user can run Docker. Its CPU architecture must match the machine type and your
  images.
- **Quota:** your EC2 quota must cover every machine: those in `ec2-pool.machine_type`,
  or one per replica with `ec2-assign`.

### Network rules

Allow these inbound TCP connections in the security groups. Host firewalls and
network ACLs must allow the same traffic and its responses.

| To                | Port                                                | From                                 |
| ----------------- | --------------------------------------------------- | ------------------------------------ |
| Agent machines    | `22` (SSH)                                          | Deploying machine                    |
| Agent machines    | `50051`-`50150` (gRPC), `6379` (Redis)              | Deploying machine and agent machines |
| Deploying machine | Endpoint gRPC port (see below)                      | Agent machines                       |
| Deploying machine | API port: `8080` by default, `8082` for Hello World | Whoever calls the API                |
| Deploying machine | Dashboard port: `8081` by default                   | Whoever opens the dashboard          |

If every machine shares one security group, add rules whose source is that same
security group for the internal traffic. Replicas sharing a machine publish gRPC
on `50051`, `50052` and up, on the machine's private IP only, and the endpoint
publishes its gRPC port on the deploying machine's private IP.

Agents send results back to the endpoint over its gRPC port. If that port is
blocked, every request stays pending. After deploying, find the port with:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Look for the host port mapped to the endpoint container's `50051`. For example,
`0.0.0.0:50052->50051/tcp` means you allow `50052`.

## How agents behave on EC2

- **Machines that go away:** a machine AWS no longer lists as running, such as a
  reclaimed spot machine, is replaced, and its replicas start again on the least
  loaded machines, or on the replacement with `ec2-assign`. With `ec2-assign`, scaling
  an agent's replicas starts or terminates its machines with them. Changing `machine_type` or `market_type` and reloading the config
  starts the machines it adds and terminates the ones it drops; their replicas
  start again on the machines kept, and calls they were running fail.

- **Routing:** agents find each other by each replica's private IP and port. A
  database or other system your code connects to must be reachable from every
  agent machine that calls it.
- **`host.docker.internal`:** inside a replica, this is the agent machine it
  runs on, not the deploying machine.
- **`otel.destinations`:** only the Global Controller exports telemetry, so these
  need to be reachable from the deploying machine only.
- **Machine metrics:** each agent machine runs a metrics collector next to its
  Redis, and the dashboard shows every machine by its private IP. Agent machines
  pull the collector from the official image of your CLI's version, so a
  development checkout's changes to it don't reach them; `canyonos deploy` warns
  when that applies.
- **LLM Gateway:** each container runs its own gateway on `127.0.0.1:8081`, as
  it does locally. See [LLM Gateway](LLM_GATEWAY.md).
- **`.env`:** the project's `.env` (see
  [Project layout](BUILD_ARTIFACT.md#what-env-is-for)) is copied over SSH to a
  private temporary folder on the agent machine, passed to
  `docker run --env-file`, and deleted once the container starts. Values
  CanyonOS sets with `-e` win over the file.
