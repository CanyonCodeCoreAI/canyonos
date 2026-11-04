class Canyonos < Formula
  desc "CLI for CanyonOS"
  homepage "https://github.com/CanyonCodeCoreAI/canyonos"
  version "0.2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-arm64"
      sha256 "83613a690d6bf1c3ec565f6db08bea3894362d2e1dd7415dd7bd065116b40e6d"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-x86_64"
      sha256 "68d0700336e9df984ec7c9fee00e4f3dca390fd24062ae85d1057f3db94faf58"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-arm64"
      sha256 "380ac81834f8e02410e6c88a27ec196e59131d13dfa723e926277ea426a623ef"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-x86_64"
      sha256 "4e29a24453889da80acd95ed60e1cb82dc7b0e25ad65b8d685f314520cbb30c1"
    end
  end

  def install
    bin.install Dir["canyonos-*"].first => "canyonos"
  end

  def caveats
    <<~EOS
      Next: canyonos quickstart
            Walks you from here to your first request.
    EOS
  end

  test do
    system "#{bin}/canyonos", "--version"
  end
end
