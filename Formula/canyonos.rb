class Canyonos < Formula
  desc "CLI for CanyonOS"
  homepage "https://github.com/CanyonCodeCoreAI/canyonos"
  version "0.1.735"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-arm64"
      sha256 "39efac4828646b2904cbb1af3d4e7db8f6642a819605655d5aa44e303003b1b0"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-x86_64"
      sha256 "5184bb46c36d2dd66d87e74269a6de841dd2f8fc701eee2936b5d00f458b568f"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-arm64"
      sha256 "9fe7a14d9e29b7d952f18ec52e9c1f3ac4210b88fadcba2a2fa85af15da978f1"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-x86_64"
      sha256 "25d870b06c03dadaf18bed6679e0753bd5966e13100d34210d9a7e5b704cb360"
    end
  end

  def install
    bin.install Dir["canyonos-*"].first => "canyonos"
  end

  test do
    system "#{bin}/canyonos", "--version"
  end
end
