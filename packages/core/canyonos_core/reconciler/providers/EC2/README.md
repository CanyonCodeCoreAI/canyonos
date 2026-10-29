# EC2 Specific Set-up

## What the host needs to deploy to EC2

** The host means the machine that you are running canyonos deploy on **

- Everything needed for local deployment. (This is Docker and the canyonos CLI)
- AWS Credentials. The host needs IAM permissions to execute certain EC2 commands. The `AmazonEC2FullAccess` policy in IAM covers all of the needed permissions. For the exact IAM permissions needed, look below in the `IAM Permissions` section.
- Same VPC as subnet_id.
  - Easiest way of doing this is making the host its own EC2 machine inside the same VPC.
- Config block added to `global_controller.yaml` (shown below). The security group would also need to allow specific ports in.

## AWS-side setup

- **Security group** (everything is inbound, same permissions needed for outbound unless you allow all outbound traffic)
  - The endpoint and dashboard run on the host, not on a launched machine. Their ports are by default 8080 and 8081, and are referred as such below
  - On the machines' security group, ports 50051–50150, 6379, and 22 need to be accessible by the security group itself; replicas sharing a machine publish on 50051, 50052 and up, on the machine's private IP only. The host must run inside the same VPC, since it reaches every machine over its private IP.
    - 50051–50150 and 6379 must be accessible over custom TCP.
    - 22 must be accessible over ssh.
  - On the host, ports 8080 and 8081 need to be accessible by whoever queries the endpoint (0.0.0.0 for example)
  - On the host, the port the endpoint publishes for its gRPC controller (on the host's private IP only) needs to be accessible by the machines' security group over custom TCP. Agents send results back there; without it every request stays "pending".

## Config (`ec2-pool:` block in `global_controller.yaml`)

`machine_type`, the pool of machines to start, is always required. When you deploy from an EC2 machine, such as one made by `canyonos provision`, any of `region`, `subnet_id` and `security_group_ids` you leave out is read from that machine's EC2 metadata (IMDSv2). Set them when deploying from elsewhere, or to launch agents somewhere else.

```yaml
provider: ec2-pool

ec2-pool:
  region: us-east-1
  machine_type:
    t3.micro: 2
  subnet_id: subnet-0123456789abcdef0
  security_group_ids:
    - sg-0123456789abcdef0
```

The deploy starts every machine listed, and every agent runs on them, each replica on the least loaded machine. When deployed from an EC2 machine, each one is tagged `canyonos-deployed-from=<that machine's id>`, so tearing it down with `canyonos provision` finds them.

## IAM permissions

The host machine needs these IAM Permissions to be able to launch external EC2 machines. This can either be held by the host itself, or the EC2 machine hosting the deployment.

- ec2:
  - RunInstances
  - TerminateInstances
  - DescribeInstances
  - DescribeInstanceTypes
  - CreateTags
  - ImportKeyPair
- IAM:
  - PassRole (only needed if you set `ec2-pool.iam_profile_name in global_controller.yaml`)

You can paste the exact JSON below in the "create manual policy" field in IAM when generating permissions for a role. Drop the `iam:PassRole` statement if you're not setting `ec2-pool.iam_profile_name`.
`iam:PassRole` gives all created machines a IAM role and its permissions, enabling stuff like Bedrock.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceTypes",
        "ec2:CreateTags",
        "ec2:ImportKeyPair"
      ],
      "Resource": "*"
    }
  ]
}
```


## [OPTIONAL] Extra Configurations in the ec2-pool block in `global_controller.yaml`

The ec2 config block given above has the bare minimum needed to get the machines up and running, to add separate settings, you can add these following fields in the block.

```yaml
ec2-pool:
  # Default to the deploying machine's own when it is an EC2 machine
  region: us-east-1
  machine_type:
    t3.micro: 2
  subnet_id: subnet-0123456789abcdef0
  security_group_ids:
    - sg-0123456789abcdef0

  # Optional Commands
  market_type: spot # For every machine in the pool; on-demand when left out.
  iam_profile_name: ec2launch # For the launched machines, if you want a specific IAM role attached to each machine, pass this variable in.
  ami_id: ami-0123456789abcdef0 # Look at `Creating your own AMI` below
  ssh_user: ubuntu # Look at `Creating your own AMI` below

ssh_private_key_path: ~/.ssh/your-own-key # Top level, not under ec2-pool. Look at `Private Key` below
```
For the iam_profile_name, you will also need to add a new policy to your IAM role in the host machine, the iam:PassRole policy. JSON below.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::<account-id>:role/<role-behind-your-iam-profile>"
    }
  ]
}
```

## [OPTIONAL] Private Key

The top-level `ssh_private_key_path` is optional, defaulting to `~/.ssh/canyonos_ec2`.
If nothing exists at that default path, canyonos generates a fresh ed25519
keypair there for you on first use (readable only by its owner: `chmod 600`).
If you set `ssh_private_key_path` to your own path instead, that file
must already exist — canyonos only auto-generates the default, never a
path you explicitly configured.

The AWS-side key pair is always automatic either way: canyonos imports
whichever key you end up with (generated or your own) into AWS on first use,
named `canyonos-ec2-<project_id>-<pubkey hash>`, so the AMI never needs the
key pre-authorized.

## [OPTIONAL] Creating your own AMI

We have provided our own base AMI_ID: ami-0101d5f2a2a9cd55c. You need to be in `us-east-1` to use our AMI. If you want to create your own, the ami you create just needs to have docker and zstd installed. The commands to install it are below.
If using a different AMI base than Ubuntu, you will need to change the ssh_user manually.

```bash

#!/bin/bash
set -eux

apt-get update
apt-get install -y docker.io zstd

systemctl enable docker
systemctl start docker

```