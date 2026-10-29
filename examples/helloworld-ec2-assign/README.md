# Hello World on EC2

[Hello World](../helloworld/README.md) set up for `provider: ec2-assign`: each replica
runs on an EC2 machine of its own, a `t3.micro` for each agent. The agents and the
endpoint are the same.

It needs no LLM keys, but EC2 charges apply. Deploy it from a machine made by
`canyonos provision`; the [EC2 deployment](../../docs/guides/EC2.md#quick-start) quick
start has every command.
