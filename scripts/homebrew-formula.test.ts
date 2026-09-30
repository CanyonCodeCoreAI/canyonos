import { describe, expect, test } from 'bun:test';

import { assets, renderFormula } from './homebrew-formula';

const hashes = {
  'canyonos-macos-arm64': 'a'.repeat(64),
  'canyonos-macos-x86_64': 'b'.repeat(64),
  'canyonos-linux-arm64': 'c'.repeat(64),
  'canyonos-linux-x86_64': 'd'.repeat(64),
};

describe('homebrew formula', () => {
  test('lists the four release assets', () => {
    expect(assets).toEqual([
      'canyonos-macos-arm64',
      'canyonos-macos-x86_64',
      'canyonos-linux-arm64',
      'canyonos-linux-x86_64',
    ]);
  });

  test('renders the version, release URLs, and hashes', () => {
    const formula = renderFormula('0.1.732', hashes);

    expect(formula).toContain('version "0.1.732"');
    expect(formula).toContain(
      'url "https://github.com/CanyonCodeCoreAI/canyonos/releases/download/v#{version}/canyonos-macos-arm64"'
    );
    expect(formula).toContain(`sha256 "${'a'.repeat(64)}"`);
    expect(formula).toContain(`sha256 "${'d'.repeat(64)}"`);
    expect(formula).not.toContain('cli-v');
    expect(formula).toStartWith('class Canyonos < Formula\n');
    expect(formula).toEndWith('end\n');
  });

  test('refuses a missing asset hash', () => {
    const { 'canyonos-linux-arm64': _missing, ...partial } = hashes;

    expect(() => renderFormula('0.1.732', partial)).toThrow('No sha256 for canyonos-linux-arm64.');
  });

  test('refuses a hash that is not sha256', () => {
    expect(() => renderFormula('0.1.732', { ...hashes, 'canyonos-macos-arm64': 'abc' })).toThrow(
      'abc is not a sha256 for canyonos-macos-arm64.'
    );
  });
});
