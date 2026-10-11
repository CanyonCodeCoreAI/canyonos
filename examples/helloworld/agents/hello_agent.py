# Example Agent
# Replace this with your agent implementation.
# The class name must match the agent's 'name' in config/global_controller.yaml.


class HelloAgent(object):
    def __init__(self):
        self.tools = [self.hello]

    def hello(self, name: str) -> str:
        """Greet someone by name."""
        return f"Hello, {name}! I'm the HelloAgent!"
