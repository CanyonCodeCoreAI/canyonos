class Canyonos < Formula
  desc "CLI for CanyonOS"
  homepage "https://github.com/CanyonCodeCoreAI/canyonos"
  version "0.1.732"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-arm64"
      sha256 "cc701314367937aa9de39c46671d45a84a653e4cd89dbdff7417391b2597324f"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-x86_64"
      sha256 "c32e5bfc005704e2836a1df022897eb342fd54185743deedee23ce7cee43d4f7"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-arm64"
      sha256 "ab0396504525e11b59da1dbfb26ee31d021fe7532fc5aca4f6ae501bda5ad23b"
    else
      url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-linux-x86_64"
      sha256 "d31a805448140e9c4fcab4bfc0ef6dc2b3a4a486ddf1e956b29dfd970d11acbe"
    end
  end

  def install
    bin.install Dir["canyonos-*"].first => "canyonos"
  end

  test do
    system "#{bin}/canyonos", "--version"
  end
end
