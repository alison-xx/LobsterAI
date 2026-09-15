'use strict';

const fs = require('fs');
const path = require('path');

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies'];
const WORKSPACE_PROTOCOL = 'workspace:';
const PACKAGES_DIR = 'workspace-packages';
const Command = { List: 'list', Stage: 'stage' };

function readPackage(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
}

// Follow only production workspace edges. Private build-time packages are
// already bundled by OpenClaw and must not be installed from the registry.
function collectRuntimeWorkspacePackages(sourceRoot) {
  const root = fs.realpathSync(sourceRoot);
  const packages = new Map();

  function visit(directory) {
    const manifest = readPackage(directory);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest[field] || {})) {
        if (!spec.startsWith(WORKSPACE_PROTOCOL) || packages.has(name)) continue;
        // pnpm has already linked workspace dependencies before the build.
        const packageDir = fs.realpathSync(path.join(directory, 'node_modules', name));
        const relativeDir = path.relative(root, packageDir);
        if (!relativeDir || relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) {
          throw new Error(`Runtime workspace dependency ${name} must be inside ${root}`);
        }
        const pkg = readPackage(packageDir);
        if (pkg.name !== name || !pkg.version) {
          throw new Error(`Runtime workspace dependency ${name} has mismatched package metadata`);
        }
        const filename = `${name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`;
        packages.set(name, { name, version: pkg.version, directory: relativeDir.split(path.sep).join('/'), filename });
        visit(packageDir);
      }
    }
  }

  visit(root);
  return [...packages.values()];
}

function stageRuntimeWorkspacePackages(sourceRoot, runtimeRoot, packDir) {
  const packages = collectRuntimeWorkspacePackages(sourceRoot);
  const source = readPackage(sourceRoot);
  const runtime = readPackage(runtimeRoot);

  for (const pkg of packages) {
    if (!fs.statSync(path.join(packDir, pkg.filename)).isFile()) {
      throw new Error(`Missing runtime workspace tarball: ${pkg.filename}`);
    }
  }
  for (const pkg of packages) {
    const relativeTarball = `${PACKAGES_DIR}/${pkg.filename}`;
    const spec = `file:./${relativeTarball}`;
    fs.mkdirSync(path.join(runtimeRoot, PACKAGES_DIR), { recursive: true });
    fs.copyFileSync(path.join(packDir, pkg.filename), path.join(runtimeRoot, relativeTarball));
    for (const field of DEPENDENCY_FIELDS) {
      if (source[field]?.[pkg.name]?.startsWith(WORKSPACE_PROTOCOL)) {
        runtime[field] = { ...runtime[field], [pkg.name]: spec };
      }
    }
    // Keep transitive consumers on the same patched build too. Relative paths
    // survive runtime relocation and subsequent channel dependency installs.
    runtime.overrides = { ...runtime.overrides, [pkg.name]: spec };
  }
  fs.writeFileSync(path.join(runtimeRoot, 'package.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  return packages;
}

if (require.main === module) {
  try {
    const [command, sourceRoot, runtimeRoot, packDir] = process.argv.slice(2);
    if (command === Command.List && sourceRoot) {
      for (const pkg of collectRuntimeWorkspacePackages(sourceRoot)) {
        process.stdout.write(`${pkg.directory}\t${pkg.filename}\n`);
      }
    } else if (command === Command.Stage && sourceRoot && runtimeRoot && packDir) {
      const packages = stageRuntimeWorkspacePackages(sourceRoot, runtimeRoot, packDir);
      console.log(`[openclaw-runtime] Staged ${packages.length} locally built workspace package(s).`);
    } else {
      throw new Error('Usage: openclaw-runtime-workspace-deps.cjs list <source> | stage <source> <runtime> <pack-dir>');
    }
  } catch (error) {
    console.error('[openclaw-runtime] Failed to prepare workspace dependencies:', error);
    process.exit(1);
  }
}

module.exports = { collectRuntimeWorkspacePackages, stageRuntimeWorkspacePackages };
