#!/usr/bin/env node
/**
 * End-to-end "developer use" test.
 *
 * For every folder in e2e/scenarios it:
 *   1. packs this library exactly as npm would publish it (`npm pack`)
 *   2. copies the scenario into a fresh temp project and installs the tarball
 *      plus the scenario's real framework dependencies from the registry
 *   3. runs the scenario's `build` script (tsc for TypeScript projects)
 *   4. starts the app as a separate process (`npm start`)
 *   5. connects with the official MCP SDK client and runs e2e/contract.mjs
 *
 * Usage: node e2e/run.mjs [scenario-name-filter...]
 * Env:   E2E_WORKDIR (default: <os tmp>/mcp-expose-e2e), E2E_KEEP=1 keeps the workdir.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContract } from './contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scenariosDir = join(root, 'e2e', 'scenarios');
const work = process.env.E2E_WORKDIR ?? join(tmpdir(), 'mcp-expose-e2e');
const filters = process.argv.slice(2);
const INSTALL_CONCURRENCY = 4;

function sh(cmd, args, cwd, { quiet = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('close', (code) =>
      code === 0
        ? resolvePromise(out)
        : reject(new Error(`${cmd} ${args.join(' ')} failed (${code}) in ${cwd}\n${out.slice(-3000)}`)),
    );
  });
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

async function waitForServer(url, child, logs, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null)
      throw new Error(`app exited with code ${child.exitCode}\n${logs.join('').slice(-3000)}`);
    try {
      await fetch(url, { method: 'GET' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`app did not start within ${timeoutMs}ms\n${logs.join('').slice(-3000)}`);
}

async function main() {
  const scenarios = readdirSync(scenariosDir)
    .filter((n) => !filters.length || filters.some((f) => n.includes(f)))
    .sort();
  if (!scenarios.length) throw new Error('no scenarios matched');

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  console.log('▸ building and packing mcp-expose');
  await sh('npm', ['run', 'build'], root);
  const packOut = await sh('npm', ['pack', '--pack-destination', work, '--json'], root);
  const tarball = join(work, JSON.parse(packOut.slice(packOut.indexOf('[')))[0].filename);
  console.log(`  ${tarball}`);

  const setupErrors = new Map();
  console.log(`▸ installing ${scenarios.length} scenario projects (concurrency ${INSTALL_CONCURRENCY})`);
  await pool(scenarios, INSTALL_CONCURRENCY, async (name) => {
    const dir = join(work, name);
    try {
      cpSync(join(scenariosDir, name), dir, { recursive: true });
      const pkgPath = join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkg.dependencies = { ...pkg.dependencies, 'mcp-expose': `file:${tarball}` };
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      await sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir);
      if (pkg.scripts?.build) await sh('npm', ['run', 'build'], dir);
      console.log(`  ✓ ${name}`);
    } catch (e) {
      setupErrors.set(name, e.message);
      console.log(`  ✗ ${name} (setup failed)`);
    }
  });

  const summary = [];
  let port = 4100;
  for (const name of scenarios) {
    const dir = join(work, name);
    const cfgPath = join(dir, 'e2e.json');
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
    console.log(`\n▸ ${name}${cfg.description ? ` — ${cfg.description}` : ''}`);
    if (setupErrors.has(name)) {
      console.log(`  ✗ setup: ${setupErrors.get(name)}`);
      summary.push({ name, passed: 0, total: 1, failed: true });
      continue;
    }

    const p = port++;
    const logs = [];
    // detached: own process group, so we can stop npm AND the node process it spawns.
    const child = spawn('npm', ['start', '--silent'], {
      cwd: dir,
      env: { ...process.env, PORT: String(p) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout.on('data', (d) => logs.push(String(d)));
    child.stderr.on('data', (d) => logs.push(String(d)));
    const url = `http://127.0.0.1:${p}${cfg.mcpPath ?? '/mcp'}`;

    let results;
    try {
      await waitForServer(url, child, logs);
      results = await runContract(url, cfg);
    } catch (e) {
      results = [{ name: 'start app', ok: false, error: e.message }];
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await new Promise((r) => (child.exitCode !== null ? r() : child.on('close', r)));
    }

    for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n      ${r.error}`}`);
    const passed = results.filter((r) => r.ok).length;
    summary.push({ name, passed, total: results.length, failed: passed !== results.length });
    if (passed !== results.length && logs.length) console.log(`  app log tail:\n${logs.join('').slice(-1500)}`);
  }

  console.log('\n══ summary ══');
  for (const s of summary) console.log(`${s.failed ? '✗' : '✓'} ${s.name.padEnd(28)} ${s.passed}/${s.total}`);
  const failed = summary.filter((s) => s.failed).length;
  console.log(failed ? `\n${failed} scenario(s) failed` : `\nall ${summary.length} scenarios passed`);
  if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
