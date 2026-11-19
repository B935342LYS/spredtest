# Security toolchain update (2026-11-19)

- Node.js: 24.22.3 (`.nvmrc`); package engine range: >=24.22.3 <25.
- Vite: 8.3.8; tsx: 4.23.15. Commit the lockfile and install with `npm ci`.
- Official security release: https://nodejs.org/en/blog/release/v24.22.3/
- Vite's MIT license text is unchanged; public notices and inventory now identify 8.3.8.
- Deployment reads `.nvmrc` and runs `npm audit` before building.

## Local Windows environment

System-wide MSI installation was blocked by execution policy. The existing system Node remains 24.12.0.
The official ZIP was verified against Node.js SHASUMS256.txt and extracted under the current user's LocalAppData.
Select the updated runtime in each PowerShell session before working:

```powershell
$env:Path = "$env:LOCALAPPDATA\spred-tools\node-v24.22.3-win-x64;" + $env:Path
node --version
npm.cmd ci
npm.cmd run build
```

This local path is machine-specific. On another machine install Node 24.22.3 or use a version manager with `.nvmrc`.

## Verification

- Working and deployment copies: clean install, npm audit (0 known vulnerabilities), TypeScript/build and license checks passed.
- Working copy: 13 of 14 existing test scripts passed. `test:view` retains the previously known Fit Height/status-footer assertion failure; product behavior was not changed to accommodate it.
- Browser: beta inputs remain locked and the copyright notice remains visible, including mobile width. External manifest requests are mocked; this does not verify Supabase access policies.
- Scope: build/development dependencies and runtime version selection. No parser, analyzer, renderer, audio or score-format changes.
