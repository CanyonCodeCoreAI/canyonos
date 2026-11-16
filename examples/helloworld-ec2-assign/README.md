# Hello World on EC2

[Hello World](../helloworld/README.md) set up for `provider: ec2-assign`: each replica
runs on an EC2 machine of its own, a `t3.micro` for each agent. The agents and the
endpoint are the same.

It needs no LLM keys, but EC2 charges apply. Deploy it from a machine made by
`canyonos provision`; the [EC2 deployment](../../docs/guides/EC2.md#quick-start) quick
start has every command. This folder is the deployment folder: its `deployment.yaml`
sets `provider: ec2-assign`, and `helloworld/` is the project. Deploy it from here:

```bash
canyonos deploy helloworld
```

Keep the project folder's name: `deployment.yaml` names the agents `helloworld.<agent>`,
and the endpoint serves `POST /helloworld/Workflow/main`.
