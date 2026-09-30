import { createHash } from 'node:crypto';
import { join } from 'node:path';

const repository = 'CanyonCodeCoreAI/canyonos';

export const assets = [
  'canyonos-macos-arm64',
  'canyonos-macos-x86_64',
  'canyonos-linux-arm64',
  'canyonos-linux-x86_64',
] as const;

export type Asset = (typeof assets)[number];
export type Hashes = Partial<Record<Asset, string>>;

const sha256Pattern = /^[0-9a-f]{64}$/;

function hashOf(hashes: Hashes, asset: Asset): string {
  const hash = hashes[asset];
  if (!hash) throw new Error(`No sha256 for ${asset}.`);
  if (!sha256Pattern.test(hash)) throw new Error(`${hash} is not a sha256 for ${asset}.`);
  return hash;
}

function stanza(hashes: Hashes, asset: Asset): string {
  return [
    `      url "https://github.com/${repository}/releases/download/v#{version}/${asset}"`,
    `      sha256 "${hashOf(hashes, asset)}"`,
  ].join('\n');
}

export function renderFormula(version: string, hashes: Hashes): string {
  return `class Canyonos < Formula
  desc "CLI for CanyonOS"
  homepage "https://github.com/${repository}"
  version "${version}"

  on_macos do
    if Hardware::CPU.arm?
${stanza(hashes, 'canyonos-macos-arm64')}
    else
${stanza(hashes, 'canyonos-macos-x86_64')}
    end
  end

  on_linux do
    if Hardware::CPU.arm?
${stanza(hashes, 'canyonos-linux-arm64')}
    else
${stanza(hashes, 'canyonos-linux-x86_64')}
    end
  end

  def install
    bin.install Dir["canyonos-*"].first => "canyonos"
  end

  test do
    system "#{bin}/canyonos", "--version"
  end
end
`;
}

async function downloadHashes(version: string): Promise<Hashes> {
  const hashes: Hashes = {};
  for (const asset of assets) {
    const url = `https://github.com/${repository}/releases/download/v${version}/${asset}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
    hashes[asset] = createHash('sha256')
      .update(new Uint8Array(await response.arrayBuffer()))
      .digest('hex');
  }
  return hashes;
}

if (import.meta.main) {
  const [version] = process.argv.slice(2);
  if (!version) throw new Error('Usage: bun run scripts/homebrew-formula.ts <version>');
  const formula = renderFormula(version, await downloadHashes(version));
  await Bun.write(join(import.meta.dir, '..', 'Formula', 'canyonos.rb'), formula);
}
