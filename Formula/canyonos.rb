class Canyonos < Formula
  desc "CLI for CanyonOS"
  homepage "https://canyonos.ai"
  version "0.2.3"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-arm64"
      sha256 "1cd52d2f9cb585b57f897b202fc98a6288d1e5bdd8dd8336e7f77ca610023fa9"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-x86_64"
      sha256 "c5a1f10babdad84a2fa5230ead4e93d48b711fe036fec9210b6dc1cede966951"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-arm64"
      sha256 "a99c50708ad7154295f3d89052b0fdd3bbfda4aed756f36077001e8be6da40d7"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-x86_64"
      sha256 "7ee2d2367d9c328dd87a0c1339eedb9d3852944990532cb46c94717ea58f4944"
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
