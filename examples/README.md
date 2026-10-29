# Examples

We have 3 example workflows listed below. All of these workflows would work immediately with canyonos, following our design philosophy.

Helloworld: No LLM involved, merely returns Hello World. The first step in building a workflow! Runs on this machine.

Helloworld-ec2-assign: Helloworld set up to run each replica on an EC2 machine of its own (`provider: ec2-assign`). See [EC2 deployment](../docs/guides/EC2.md#quick-start).

Portfolio: Manages your portfolio for you. You can state some holdings in plain English, and it will fetch each stock's price history, compute its returns and risk, roll that up into a risk profile for the whole portfolio, and write you a short briefing on it. 

PR review: Reviews a pull request with three agents: one runs the tests, one reviews the change with an LLM, one merges it. Its `config/governance.yaml` refuses the merge while the test runner is down and moves the review to a cheaper model once it has spent more than $5.

Each example declares its own ports in `config/global_controller.yaml` (Helloworld: API 8082, Redis 6380; Portfolio: API 8080, Redis 6379; PR review: API 8083, Redis 6382), so all of them can be deployed on the same machine at once.
