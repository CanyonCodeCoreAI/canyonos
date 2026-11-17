class Canyonos < Formula
  desc "CLI for CanyonOS"
  homepage "https://canyonos.ai"
  version "0.2.2"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-arm64"
      sha256 "57e7506e4a6eb69c1ecd11c8ac97360adba11935ac63f08f2eab713f90ff2f73"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-x86_64"
      sha256 "ea8bacf38f4b8d267b8ac90d99a2e63dc8d597ff9d3e511338bd678ff023632b"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-arm64"
      sha256 "3d57679726c7e86a7712fce4a43d82dff3847d657964ee8f8d54b8c0cace4396"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-x86_64"
      sha256 "4a8c35bea5d50f07745fbf78a3f8b23cea25988dda7288f68bcc3cf31d44a8e9"
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
