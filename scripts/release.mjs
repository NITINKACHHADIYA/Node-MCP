#!/usr/bin/env node
/**
 * Release helpers used by .github/workflows/release.yml and the `version` npm script.
 * See RELEASING.md for the full process.
 *
 *   node scripts/release.mjs dist-tag <version> [currentLatest]   → prints the npm dist-tag to publish under
 *   node scripts/release.mjs check-branch <branch> <version>      → fails unless <version> may be released from <branch>
 *   node scripts/release.mjs changelog <version> [date]           → moves "Unreleased" entries under a new version heading
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const REPO_URL = 'https://github.com/NITINKACHHADIYA/Node-MCP';

/**
 * Which npm dist-tag a version is published under.
 *  - prereleases                 → `next`       (never installed by default)
 *  - newest stable version       → `latest`     (`npm install mcp-expose`)
 *  - fix for an older major line → `latest-<major>` (e.g. `npm install mcp-expose@latest-3`)
 * Publishing a v3 fix therefore never moves `latest` away from v5.
 */
export function distTagFor(version, currentLatest) {
  if (!semver.valid(version)) throw new Error(`Invalid version: ${version}`);
  if (semver.prerelease(version)) return 'next';
  if (!currentLatest || !semver.valid(currentLatest) || semver.gt(version, currentLatest)) return 'latest';
  return `latest-${semver.major(version)}`;
}

/**
 * Releases come from `main` (current major and new majors) or from a
 * maintenance branch `v<major>.x`, which may only release its own major.
 */
export function checkReleaseBranch(branch, version) {
  if (!semver.valid(version)) throw new Error(`Invalid version: ${version}`);
  if (branch === 'main') return;
  const m = /^v(\d+)\.x$/.exec(branch);
  if (!m) throw new Error(`Releases must come from "main" or a maintenance branch like "v3.x", not "${branch}".`);
  if (Number(m[1]) !== semver.major(version)) {
    throw new Error(
      `Branch ${branch} can only release ${m[1]}.x versions, not ${version}. Majors are released from main.`,
    );
  }
}

/** Move the "Unreleased" section of a Keep-a-Changelog file under a new version heading. */
export function updateChangelog(text, version, date) {
  const head = '## [Unreleased]';
  const start = text.indexOf(head);
  if (start === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.');
  const afterHead = start + head.length;
  const next = text.indexOf('\n## [', afterHead);
  const body = text.slice(afterHead, next === -1 ? undefined : next).trim();
  if (!body && !semver.prerelease(version)) {
    throw new Error('CHANGELOG.md "Unreleased" section is empty. Describe the changes before releasing.');
  }
  const section = `${head}\n\n## [${version}] - ${date}${body ? `\n\n${body}` : ''}\n`;
  let out = text.slice(0, start) + section + (next === -1 ? '' : text.slice(next));

  // Link references at the bottom.
  const unreleasedRef = /^\[Unreleased\]: .*$/m;
  const compare = `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD`;
  const versionRef = `[${version}]: ${REPO_URL}/releases/tag/v${version}`;
  out = unreleasedRef.test(out)
    ? out.replace(unreleasedRef, `${compare}\n${versionRef}`)
    : `${out.trimEnd()}\n\n${compare}\n${versionRef}\n`;
  return out;
}

function currentNpmLatest(pkgName) {
  try {
    return execFileSync('npm', ['view', pkgName, 'dist-tags.latest'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined; // not published yet
  }
}

function main([cmd, ...args]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
  switch (cmd) {
    case 'dist-tag': {
      const [version = pkg.version, latest = currentNpmLatest(pkg.name)] = args;
      console.log(distTagFor(version, latest));
      break;
    }
    case 'check-branch': {
      const [branch, version = pkg.version] = args;
      checkReleaseBranch(branch, version);
      console.log(`ok: ${version} may be released from ${branch}`);
      break;
    }
    case 'changelog': {
      const [version = pkg.version, date = new Date().toISOString().slice(0, 10)] = args;
      const file = `${root}CHANGELOG.md`;
      writeFileSync(file, updateChangelog(readFileSync(file, 'utf8'), version, date));
      console.log(`CHANGELOG.md: added ${version}`);
      break;
    }
    default:
      throw new Error(`Unknown command "${cmd}". Use dist-tag | check-branch | changelog.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`release: ${err.message}`);
    process.exit(1);
  }
}
