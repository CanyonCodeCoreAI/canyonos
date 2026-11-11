# Roadmap

Work we plan to do next. Nothing here is promised for a specific release.

## Design philosophy

We strongly advocate simplicity in the workflows you build, and we strive for it too.
We will fold in and consolidate the pieces of CanyonOS that you currently have to
configure by hand for the runtime, with the eventual goal of running plain Python code
on CanyonOS.

Things we will address:

- Everything needs to be in a class.

Note: Our skill file handles all of these problems, so try it out!

## Stale future detection

If an agent process crashes mid-execution, a Future's result may never arrive, and the
caller waits forever. A timeout covers this today; we will add configurable retry
policies.
