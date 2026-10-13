class Canyonos < Formula
  desc "CLI for CanyonOS"
  homepage "https://github.com/CanyonCodeCoreAI/canyonos"
  version "0.1.736"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-arm64"
      sha256 "dba53934e40966a9efc9eb72104444cde0413eff4d0a0df41c16c1e6659d098c"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-x86_64"
      sha256 "5f748240f47c705fda4d628d69a7fd8d61b3cb70e0f2724b71fa0ed7d1a3cd3d"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-arm64"
      sha256 "ed2e3ed8532e75327f9807c951b35bfe1e166cc038a5b93aead94e6f147c15e3"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-x86_64"
      sha256 "44537d5f6b4d71aebb0a74a041afd2b67bfa896e134c9ef64ee00cae9184b73a"
    end
  end

  def install
    bin.install Dir["canyonos-*"].first => "canyonos"
  end

  test do
    system "#{bin}/canyonos", "--version"
  end
end
