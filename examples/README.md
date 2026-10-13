# Examples

We have 2 example workflows listed below. All of these workflows would work immediately with canyonos, following our design philosophy.

Helloworld: No LLM involved, merely returns Hello World. The first step in building a workflow!

Portfolio: Manages your portfolio for you. You can state some holdings in plain English, and it will fetch each stock's price history, compute its returns and risk, roll that up into a risk profile for the whole portfolio, and write you a short briefing on it. 

Each example declares its own ports in `config/global_controller.yaml` (Helloworld: API 8082, Redis 6380; Portfolio: API 8080, Redis 6379), so both can be deployed on the same machine at once.
