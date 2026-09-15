import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const tar = require('tar');
const { collectRuntimeWorkspacePackages, stageRuntimeWorkspacePackages } = require('../scripts/openclaw-runtime-workspace-deps.cjs');
const tempDirs: string[] = [];
const AI_PACKAGE = '@openclaw/ai';
const SHARED_PACKAGE = '@openclaw/shared-fixture';
const VERSION = '2026.8.1';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-workspace-deps-'));
  tempDirs.push(root);
  const source = path.join(root, 'source with spaces');
  const runtime = path.join(root, 'runtime');
  const pack = path.join(root, 'pack');
  const ai = path.join(source, 'packages', 'ai');
  const shared = path.join(source, 'packages', 'shared');
  fs.mkdirSync(pack);
  writeJson(path.join(source, 'package.json'), {
    dependencies: { [AI_PACKAGE]: 'workspace:*', 'registry-only': '1.0.0' },
    devDependencies: { 'build-only': 'workspace:*' },
  });
  writeJson(path.join(ai, 'package.json'), {
    name: AI_PACKAGE, version: VERSION, dependencies: { [SHARED_PACKAGE]: 'workspace:*' },
    devDependencies: { 'private-build-only': 'workspace:*' },
  });
  writeJson(path.join(shared, 'package.json'), { name: SHARED_PACKAGE, version: VERSION });
  for (const [parent, name, target] of [[source, AI_PACKAGE, ai], [ai, SHARED_PACKAGE, shared]]) {
    const link = path.join(parent, 'node_modules', name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  writeJson(path.join(runtime, 'package.json'), {
    name: 'runtime-fixture', version: '1.0.0', dependencies: { [AI_PACKAGE]: VERSION },
    overrides: { unrelated: '1.2.3' },
  });
  return { root, source, runtime, pack, ai, shared };
}

test('collects direct and transitive production workspace packages, excluding build and registry dependencies', () => {
  const { source } = fixture();
  expect(collectRuntimeWorkspacePackages(source)).toEqual([
    { name: AI_PACKAGE, version: VERSION, directory: 'packages/ai', filename: `openclaw-ai-${VERSION}.tgz` },
    { name: SHARED_PACKAGE, version: VERSION, directory: 'packages/shared', filename: `openclaw-shared-fixture-${VERSION}.tgz` },
  ]);
});

test('rejects a missing tarball before changing the runtime manifest', () => {
  const { source, runtime, pack } = fixture();
  const manifestPath = path.join(runtime, 'package.json');
  const before = fs.readFileSync(manifestPath);
  expect(() => stageRuntimeWorkspacePackages(source, runtime, pack)).toThrow();
  expect(fs.readFileSync(manifestPath)).toEqual(before);
});

test('installs patched exports and transitive packages offline after runtime relocation', () => {
  const { root, source, runtime, pack } = fixture();
  for (const pkg of collectRuntimeWorkspacePackages(source)) {
    const stage = path.join(root, `stage-${pkg.filename}`);
    const packageDir = path.join(stage, 'package');
    const isAi = pkg.name === AI_PACKAGE;
    writeJson(path.join(packageDir, 'package.json'), {
      name: pkg.name, version: VERSION, type: 'module',
      exports: isAi ? { './internal/shared': './index.mjs' } : './index.mjs',
      dependencies: isAi ? { [SHARED_PACKAGE]: VERSION } : {},
    });
    fs.writeFileSync(path.join(packageDir, 'index.mjs'), isAi
      ? `import { marker } from '${SHARED_PACKAGE}'; export const prepareReplayMessages = () => marker;`
      : 'export const marker = "patched-local-build";');
    tar.c({ cwd: stage, file: path.join(pack, pkg.filename), gzip: true, sync: true }, ['package']);
  }
  stageRuntimeWorkspacePackages(source, runtime, pack);
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
  expect(manifest.overrides.unrelated).toBe('1.2.3');
  expect(manifest.dependencies[AI_PACKAGE]).toBe(`file:./workspace-packages/openclaw-ai-${VERSION}.tgz`);
  const relocated = path.join(root, 'relocated runtime');
  fs.renameSync(runtime, relocated);
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(pack, { recursive: true, force: true });

  const npmArgs = ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(root, 'npm-cache')];
  // npm_execpath is available under npm test on every supported platform and
  // avoids executing a .cmd shim or shell-quoting paths on Windows.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this integration test with npm test');
  execFileSync(process.execPath, [npmCli, ...npmArgs], { cwd: relocated, stdio: 'pipe' });
  // A later channel dependency install must keep using the patched package.
  execFileSync(process.execPath, [npmCli, ...npmArgs], { cwd: relocated, stdio: 'pipe' });
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { prepareReplayMessages } from '${AI_PACKAGE}/internal/shared'; console.log(prepareReplayMessages());`,
  ], { cwd: relocated, encoding: 'utf8' });
  expect(output.trim()).toBe('patched-local-build');
  expect(fs.lstatSync(path.join(relocated, 'node_modules', AI_PACKAGE)).isSymbolicLink()).toBe(false);
});
