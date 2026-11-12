# All guides

## Getting started

- [Installation](../INSTALLATION.md): install the CLI and check your machine.
- [How it works](../HOW_IT_WORKS.md): what runs where when you deploy.
- [What CanyonOS offers](COMPARISONS.md): what CanyonOS covers, and related tools.

## Build a workflow

- [Start from scratch](FROM_SCRATCH.md): create a workflow in plain Python, configure
  it and deploy it, step by step.
- [Configure your workflow](CONFIGURE.md): every file in `config`, how a change applies,
  and the common changes.
- [Convert an existing workflow](CONVERT_WORKFLOW.md): for an app built with another
  framework; convert it with `canyonos convert`, then test, deploy and send requests.

## Deploy

- [Local](LOCAL.md): everything on this machine, with Docker.
- [EC2](EC2.md): agents on EC2 machines, with `provider: ec2-pool` or `ec2-assign`.
- [Kubernetes](KUBERNETES.md): the whole workflow on a Kubernetes cluster, run by the
  CanyonOS operator.
- [Dashboard](DASHBOARD.md): how to open the local dashboard, find a run, and read each
  page.

## Reference

- [CLI reference](CLI.md): every `canyonos` command and its options.
- [Workflow config](WORKFLOW_CONFIG.md): `config/workflow_config.yaml`, every key,
  with defaults.
- [LLM Gateway](LLM_GATEWAY.md): the models agents may use and what a call may cost, set
  in `llms.yaml`, how OpenAI, Anthropic and Bedrock calls reach the gateway, and its
  network limits.
- [Prompt management](PROMPTS.md): agent prompts, and how to view and edit them on the
  dashboard.
- [Autoscaling](SCALING.md): the policy that adds and removes agent replicas under load.
- [Runtime contract](RUNTIME_CONTRACT.md): how agents are loaded, called, stubbed and
  torn down.
- [Images and dependencies](IMAGES_AND_DEPENDENCIES.md): what Python can import from
  `/app`, what gets installed, and what the build leaves out.
- [Troubleshooting](TROUBLESHOOTING.md): common problems, what causes them and how to
  fix them.

## In depth

- [Workflow design](WORKFLOW_DESIGN.md): how we think about workflows, and when to split
  work into agents.
- [Workflow layout](BUILD_ARTIFACT.md): which folder is the workflow root, what becomes
  `/app` in the containers, and the names the platform uses.
- [What a workflow needs](WORKFLOW_REQUIREMENTS.md): what an existing app has to meet
  before you convert it.
- [Architecture](../architecture/README.md): how each component works inside.
