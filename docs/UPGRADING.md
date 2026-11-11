# Upgrading

What changed in each release is in the
[release notes on GitHub](https://github.com/CanyonCodeCoreAI/canyonos/releases). This
page covers the changes you have to act on.

## From 0.2.1

The release after 0.2.1 renames the workflow config from `config/global_controller.yaml`
to `config/workflow_config.yaml`, and doesn't read the old name. Rename the file in each
workflow, under `.canyon/config` for a converted one, before you deploy:

```bash
git mv config/global_controller.yaml config/workflow_config.yaml   # or mv
```

Nothing inside the file changes. `canyonos new-app` now leaves out the keys that only
restated a default, such as `otel`, `poll_interval` and `redis`; a file that keeps them
works as before.

Agent code no longer needs `.value()`: a call's result can be used as it is, as the
type its function declares under `returns`. Code that calls `.value()` keeps working
and still gets the stored text; see
[Results of agent calls](guides/RUNTIME_CONTRACT.md#results-of-agent-calls).

## From 0.1.x to 0.2.0

0.2.0 follows 0.1.738. It renames the `.car` folder, two commands and several config
keys. After upgrading, `canyonos validate` names every old key in
`global_controller.yaml` it finds.

### 1. Stop the old deploy first

Before upgrading, stop any running deploy with the CLI that started it:

```bash
canyonos quit
```

0.2.0 names containers differently, so its `canyonos stop` can't find a deploy that
0.1 started.

### 2. Upgrade the CLI

```bash
uv tool upgrade canyonos    # or upgrade with the tool you installed it with
canyonos --version          # 0.2.0
```

### 3. Rename `.car` to `.canyon`

A workflow converted with 0.1 has a `.car` folder, with the code in `.car/app`. In 0.2.0
the folder is `.canyon` and the code sits directly in it. Either run `canyonos convert`
again, or move it by hand:

```bash
mv .car .canyon
mv .canyon/app/* .canyon/
rmdir .canyon/app
rm -rf .canyon/stubs .canyon/grpc_stubs .canyon/docker_container
```

The last line removes folders the 0.1 build generated. Keep `.env` in the folder you run
`canyonos` from, next to `.canyon`, not inside it.

### 4. Update `global_controller.yaml`

| 0.1                             | 0.2.0                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` on each agent        | one `provider` for the whole deployment, at the top level                                                                                 |
| `provider: EC2`                 | `provider: ec2-pool`, or `ec2-assign` for one machine per replica                                                                         |
| `ec2:`                          | `ec2-pool:`                                                                                                                               |
| `instance_type` on each agent   | `ec2-pool.machine_type`: how many machines of each type to start. With `ec2-assign`, `ec2-assign.machine_type` gives each agent its type. |
| `instance_profile_name`         | `iam_profile_name`                                                                                                                        |
| `host` and `user` on each agent | removed                                                                                                                                   |
| `env_file`                      | removed: the `.env` in the workflow folder reaches the agents by itself                                                                   |

`canyonos deploy -c <file>` and `canyonos validate -c <file>` are gone too. The config
is always `config/global_controller.yaml` in the workflow folder.

With `ec2-pool`, the agent machines' security group must allow TCP `50051`-`50150`
from itself; see [EC2 deployment](guides/EC2.md).

### 5. Use the new command names

| 0.1              | 0.2.0                            |
| ---------------- | -------------------------------- |
| `canyonos build` | `canyonos convert`, now optional |
| `canyonos quit`  | `canyonos stop`                  |

`canyonos stop` now does what `quit` did: it removes the deploy's containers and its
copy of the workflow. In 0.1 it only halted the deploy and kept them. `stop --all` and
`clean --all` are new and act on every project on the machine; see
[Stop and clean up](guides/CLI.md#stop-and-clean-up).

### Other changes you may notice

- The endpoint answers `400` when a request leaves out an argument the method declares.
- `stop`, `clean`, `logs`, `config` and `status` exit with `1` on failure, and errors
  and warnings go to stderr. Scripts that read their output may need a change.
- The conversion skill is now called `converting-to-canyonos`.
- On the dashboard, the error types `NoEndpointFound`, `InvalidFutureArg` and
  `ResultCallbackFailed` are now `NoRunningReplica`, `InvalidArgument` and
  `ResultNotDelivered`.
- Usage reporting is on by default. The CLI tells you before it sends anything, and
  `canyonos contact --usage off` turns it off; see
  [Usage reporting](guides/CLI.md#usage-reporting).
