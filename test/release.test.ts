import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs maintenance script without type declarations
import { checkReleaseBranch, distTagFor, updateChangelog } from '../scripts/release.mjs';

describe('npm dist-tags for multi-version maintenance', () => {
  it('first release and newer versions become `latest`', () => {
    expect(distTagFor('0.1.0', undefined)).toBe('latest');
    expect(distTagFor('5.2.0', '5.1.3')).toBe('latest');
    expect(distTagFor('6.0.0', '5.2.0')).toBe('latest');
  });

  it('a fix on an older major (v3 while v5 is current) does not move `latest`', () => {
    expect(distTagFor('3.4.1', '5.2.0')).toBe('latest-3');
    expect(distTagFor('3.5.0', '5.2.0')).toBe('latest-3');
  });

  it('prereleases go to `next`', () => {
    expect(distTagFor('6.0.0-beta.1', '5.2.0')).toBe('next');
  });
});

describe('release branch rules', () => {
  it('main can release any version', () => {
    expect(() => checkReleaseBranch('main', '5.3.0')).not.toThrow();
    expect(() => checkReleaseBranch('main', '6.0.0')).not.toThrow();
  });

  it('maintenance branches only release their own major', () => {
    expect(() => checkReleaseBranch('v3.x', '3.4.1')).not.toThrow();
    expect(() => checkReleaseBranch('v3.x', '3.5.0')).not.toThrow();
    expect(() => checkReleaseBranch('v3.x', '4.0.0')).toThrow(/only release 3.x/);
  });

  it('rejects feature branches', () => {
    expect(() => checkReleaseBranch('feature/x', '5.3.0')).toThrow(/maintenance branch/);
  });
});

describe('changelog', () => {
  const base = `# Changelog

## [Unreleased]

### Fixed

- Koa: handle empty bodies.

## [3.4.0] - 2026-01-01

- Older entry.

[Unreleased]: https://github.com/NITINKACHHADIYA/Node-MCP/compare/v3.4.0...HEAD
[3.4.0]: https://github.com/NITINKACHHADIYA/Node-MCP/releases/tag/v3.4.0
`;

  it('moves Unreleased entries under the new version and updates links', () => {
    const out = updateChangelog(base, '3.4.1', '2026-09-25');
    expect(out).toContain(
      '## [Unreleased]\n\n## [3.4.1] - 2026-09-25\n\n### Fixed\n\n- Koa: handle empty bodies.\n\n## [3.4.0]',
    );
    expect(out).toContain('[Unreleased]: https://github.com/NITINKACHHADIYA/Node-MCP/compare/v3.4.1...HEAD');
    expect(out).toContain('[3.4.1]: https://github.com/NITINKACHHADIYA/Node-MCP/releases/tag/v3.4.1');
    expect(out).toContain('[3.4.0]: https://github.com/NITINKACHHADIYA/Node-MCP/releases/tag/v3.4.0');
  });

  it('refuses a stable release with nothing in Unreleased', () => {
    const empty = updateChangelog(base, '3.4.1', '2026-09-25');
    expect(() => updateChangelog(empty, '3.4.2', '2026-09-26')).toThrow(/empty/);
  });
});
