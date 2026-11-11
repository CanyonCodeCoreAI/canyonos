class Canyonos < Formula
  desc "CLI for CanyonOS"
  homepage "https://canyonos.ai"
  version "0.2.1"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-arm64"
      sha256 "ee1c4adca0cbed20066d19ca65cd6589f67b61274559f23f2d35c0a1663b9439"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-x86_64"
      sha256 "cd7abb0721da133b66546163f162fff9930b36456a7181911f6d1786982160b4"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-arm64"
      sha256 "95cd99fe07f8fcb0271d08d380f9c765487774836eac89c52ed5e0e4d2d7e1bf"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-x86_64"
      sha256 "ad2b67143f63a4cfa2725b0b8ef8e430d1b57859f37abc736e35b55d08a5401c"
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
