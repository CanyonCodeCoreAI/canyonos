# Homebrew

This folder is the Homebrew tap for the `canyonos` CLI. It installs the prebuilt
binary for macOS or Linux (arm64 or x86_64) from the GitHub release.

## Install

```bash
brew tap CanyonCodeCoreAI/canyonos https://github.com/CanyonCodeCoreAI/canyonos
brew trust --formula CanyonCodeCoreAI/canyonos/canyonos
brew install canyonos
```

## Upgrade

```bash
brew update
brew upgrade canyonos
```

## Uninstall

```bash
brew uninstall canyonos
brew untap CanyonCodeCoreAI/canyonos
```
