# Versioning and releasing

mcp-expose follows [Semantic Versioning](https://semver.org). Several major versions can be maintained at
the same time, so users who cannot upgrade immediately still get fixes.

## Version numbers

| Change                                                                                           | Bump      | Example       |
| ------------------------------------------------------------------------------------------------ | --------- | ------------- |
| Bug fix, no API change                                                                           | **patch** | 3.4.0 → 3.4.1 |
| New feature or option, backwards compatible                                                      | **minor** | 3.4.1 → 3.5.0 |
| Breaking change (removed/renamed API, changed default behaviour, dropped Node/framework version) | **major** | 3.5.0 → 4.0.0 |

While the version is `0.x`, the API is still settling. Breaking changes bump the minor version (0.1 → 0.2)
and fixes bump the patch. `1.0.0` is released once the API is considered stable.

## Branches

```
main ──●──●──●──●──●──●──●──►  5.x development: current major, next major work
           \        \
            \        v4.x ──●──●──►   4.x maintenance (fixes, safe backports)
             v3.x ──●──●──●──►        3.x maintenance
```

- **`main`**: the current major. New majors are also released from `main`.
- **`v<major>.x`**: one maintenance branch per older supported major, e.g. `v3.x`. Only that major's
  versions can be released from it. The release tooling rejects a `4.0.0` from `v3.x`.
- Every change reaches these branches through a pull request. CI runs on `main` and on every `v*.x` branch.

## npm dist-tags

| Release                           | dist-tag                           | Users install with                                   |
| --------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| Newest stable version             | `latest`                           | `npm i mcp-expose`                                   |
| Fix or backport on an older major | `latest-<major>` (e.g. `latest-3`) | `npm i mcp-expose@latest-3` or `npm i mcp-expose@^3` |
| Prerelease (`6.0.0-beta.1`)       | `next`                             | `npm i mcp-expose@next`                              |

The tag is chosen automatically (`scripts/release.mjs dist-tag`). **Publishing a 3.x fix never moves
`latest` away from 5.x.** Users with `^3.4.0` in their `package.json` get the fix on their next install.

## Scenario: v5 is current and a bug is reported in v3

1. **Reproduce** it on `v3.x`, and check whether `main` (v5) and `v4.x` have it too.
2. **Fix it on the newest affected line first**, usually `main`: open a PR with the fix, a test, and a
   `CHANGELOG.md` entry under _Unreleased_.
3. **Backport** by adding the label `backport v3.x` (and `backport v4.x` if affected) to the PR. When it
   is merged, the _Backport_ workflow opens cherry-pick PRs against those branches. If the cherry-pick
   conflicts, the workflow comments on the PR. Then do it by hand:
   ```bash
   git switch v3.x && git pull
   git switch -c fix/koa-empty-body-v3
   git cherry-pick -x <commit-sha>      # resolve conflicts, run npm test
   git push -u origin HEAD              # open a PR into v3.x
   ```
   If the bug exists **only** in v3, open the fix PR directly against `v3.x`.
4. Make sure the backport PR also adds the entry under _Unreleased_ in `v3.x`'s `CHANGELOG.md`.
5. **Release** from GitHub: _Actions → Release → Run workflow_, choose branch **`v3.x`** and bump
   **`patch`** for a fix, or **`minor`** for a backported feature. The workflow:
   - bumps `3.4.0 → 3.4.1` (or `3.5.0`) and moves the _Unreleased_ changelog entries under the new version
   - runs build, typecheck, tests and package checks
   - pushes the release commit and tag `v3.4.1` to `v3.x`
   - publishes to npm under `latest-3`, and creates a GitHub release that is not marked "latest"
6. Release `main` and `v4.x` the same way if they received the fix too.

## Regular releases from `main`

_Actions → Release → Run workflow_, branch **`main`**, bump `patch` / `minor` / `major`, or a `pre*`
bump with a `preid` such as `beta` for prereleases.

Alternatively, from a terminal on an up-to-date branch:

```bash
npm version patch            # or minor / major / prerelease --preid beta
git push --follow-tags       # pushing the tag triggers the publish job
```

`npm version` runs `scripts/release.mjs changelog`, which refuses a stable release while _Unreleased_ is
empty.

## Starting maintenance of an old major

Right before releasing a new major (for example `6.0.0` from `main`), create the maintenance branch for
the previous one from its last release tag:

```bash
git fetch --tags
git branch v5.x v5.9.2         # last 5.x release
git push origin v5.x
```

Then add `v5.x` to the branch protection rule, and update the support table in
[SECURITY.md](SECURITY.md).

## End of life

When a major reaches end of life (see [SECURITY.md](SECURITY.md#supported-versions)):

1. Release a final version if fixes are pending.
2. Deprecate it on npm so users are warned on install:
   `npm deprecate mcp-expose@"3.x" "mcp-expose 3.x is no longer maintained, please upgrade to 5.x"`
3. Keep the `v3.x` branch (read-only) for reference, and update the support table.

## One-time setup (already done unless noted)

- `NPM_TOKEN` repository secret: an npm _automation_ token with publish rights. **Maintainer action.**
- An `npm` environment (Settings → Environments). Optionally require approval, so every publish is confirmed by a maintainer.
- Branch protection for `main` and `v*.x`. If it blocks pushes from GitHub Actions, allow the
  `github-actions[bot]` to bypass, or release from a terminal instead.
