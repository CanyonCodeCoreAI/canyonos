# Roadmap

Work we plan to do next. Nothing here is promised for a specific release.


## Design Philosophy

We greatly advocate for simplicity in the workflows you build, and we strive for that too. We will be folding in and consolidating pieces of CanyonCode that you currently have to manually configure for runtime, for the eventual code of being able to run pure plain python code on CanyonOS.

Things we will address:
- agents .yaml files needed for each agent
- From deploy import deploy and deploy(main,8080) in the workflow code
- Everything needs to be in a Class
- Needing to add .value() when you want to call the result of a function
Note: All of these problems are handled by our skill file, try it out!

## Stale future detection

If an agent process crashes mid-execution, a Future's result may never arrive, and the
caller waits forever. A timeout covers this today; we will add configurable retry
policies.
