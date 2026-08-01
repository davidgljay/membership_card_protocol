#!/usr/bin/env node
// Rewrites any @membership-card-protocol/* `file:` dependency in the
// current directory's package.json to a real, npm-resolvable version, right
// before packing/publishing. Local dev, builds, and tests all keep using
// `file:` links -- the only way this repo can reference a package that
// lives in a different top-level directory without it being published yet
// (these are five separate pnpm workspaces, not one, so pnpm's own
// `workspace:*` protocol doesn't reach across them). Only the published
// tarball's package.json ever sees a real version; the caller
// (publish-npm-package.sh) reverts package.json via `git checkout` after
// publish, in both dev and prod, so this rewrite never lands in the
// committed tree.
//
// Usage: node rewrite-file-deps.mjs <dev|prod>
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const environment = process.argv[2];
if (environment !== 'dev' && environment !== 'prod') {
  console.error('Usage: rewrite-file-deps.mjs <dev|prod>');
  process.exit(1);
}

const pkgPath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
let changed = false;

for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!dep.startsWith('@membership-card-protocol/') || !spec.startsWith('file:')) {
    continue;
  }

  let resolved;
  if (environment === 'dev') {
    // Dev publishes are prerelease versions (see publish-npm-package.sh's
    // <version>-dev.<sha>.<timestamp> scheme) -- a plain semver range
    // wouldn't resolve to a matching prerelease, so pin the exact version
    // currently published under the 'next' dist-tag instead. This also
    // enforces publish order for free: publishing a dependent package
    // before its dependency has a 'next' version fails here, loudly.
    try {
      resolved = execSync(`npm view ${dep}@next version`, { encoding: 'utf-8' }).trim();
    } catch {
      console.error(
        `::error::Could not resolve ${dep}@next from the registry -- publish its dev prerelease first (see this package's DEPLOYMENT.md for the required order).`,
      );
      process.exit(1);
    }
  } else {
    // Prod: use a caret range against the dependency's own current version
    // (read from its local package.json, not the registry) -- consistent
    // with prod's tag-triggered, human-versioned publish convention
    // (publish-verifier.yml), where the registry may not have that version
    // published yet at the moment this package's version is bumped.
    const depDir = path.resolve(spec.slice('file:'.length));
    const depPkg = JSON.parse(fs.readFileSync(path.join(depDir, 'package.json'), 'utf-8'));
    resolved = `^${depPkg.version}`;
  }

  console.log(`[rewrite-file-deps] ${dep}: ${spec} -> ${resolved}`);
  pkg.dependencies[dep] = resolved;
  changed = true;
}

if (changed) {
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}
