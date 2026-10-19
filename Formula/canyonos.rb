class Canyonos < Formula
  desc "CLI for CanyonOS"
  homepage "https://github.com/CanyonCodeCoreAI/canyonos"
  version "0.1.738"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-arm64"
      sha256 "5da0973c0014ac38d35fdd96c8a94c4ac88d954cdf65b5c063827b05aca0f4ca"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-x86_64"
      sha256 "86bd40b803fe4608d68f9e67b78cca0a3a48121d4f67ef8830deb4c3eb5e63d3"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-arm64"
      sha256 "e6a4cfb635c6053fe9fe42366b6e83a7ce9868dc8e702e6a0bc340a0d9310db1"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-x86_64"
      sha256 "776090a96ea50295bf30a59af18aa006ef79702dae61fb675754db5cb8b16392"
    end
  end

  def install
    bin.install Dir["canyonos-*"].first => "canyonos"
  end

  test do
    system "#{bin}/canyonos", "--version"
  end
end
