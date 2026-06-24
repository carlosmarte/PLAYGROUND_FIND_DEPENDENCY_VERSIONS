# Audit findings — subprocess buffer / verbose scan

Scan of `node-cli/*/main.mjs` and `python-cli/*/main.py` for the three `pip`
bug patterns. `pip` itself is **already fixed** (reference). Line numbers are
indicative — confirm at edit time.

Legend:
- **Discovery** = how the tool lists available versions (`subprocess` vs `HTTP`).
- **Fix A** = strip verbose flag from the discovery query (only when discovery
  is a subprocess that injects a verbose flag).
- **Fix B** = add `maxBuffer` to output-capturing `spawnSync` (Node only).
- **Fix C** = surface signal name in the subprocess error block (both langs).
- `blank` = error block prints only stderr → fully blank on signal-kill (worst).
- `enh` = block already has a `|| "unknown error"` fallback; Fix C is an
  enhancement (also surface the *signal name*), not a blank-output bug.

## Tier 1 — subprocess discovery (verbose injected) → A + B + C

| Tool | Discovery cmd | Node A / B / C (main.mjs) | Python A / C (main.py) |
|------|---------------|---------------------------|-------------------------|
| alpine | `apk policy <pkg>` | A:115 / B:119,164,210,226 / C:126 `blank` | A:119 / C:132 `blank` |
| conda | `conda search <pkg> --json` | A:115 / B:119 / C:125 `blank` | A:115 / C:128 `blank` |
| debian | `apt-cache madison <pkg>` (`-o Debug::...` verbose) | A:121 / B:124,183,286 / C:131 `blank` | A:120 / C:131 `blank` |
| go | `go list -m -versions <pkg>` (`-x` verbose) | A:114 / B:119,177,263 / C:122 `blank` | A:116 / C:130 `blank` |
| helm | `helm search repo` (`--debug` verbose) | A:143 / B:146 / C:149 `blank` | A:152 / C:163 `blank` |
| rpm | `dnf --showduplicates list <pkg>` | A:118 / B:123 / C:130 `blank` | A:119 / C:132 `blank` |
| spm | `git ls-remote --tags <repo>` (`--verbose`) | A:121 / B:125 / C:128 `blank` | A:121 / C:132 `blank` |
| uv | `uv pip index versions <pkg>` | A:111 / B:115,314 / C:111-124 (review) | A:117 / C:134 `blank` |

## Tier 2 — special-cased subprocess discovery

| Tool | Note | Node A / B / C | Python A / C |
|------|------|----------------|--------------|
| pacman | `pacman -Si` injects `--debug`; also has HTTP source | A:122 (`--debug`) / B:124 / C:128-131 partial | A:no strip / C:partial |
| npm | `npm view <pkg> versions --json`; verbose is `--loglevel`, **not** `^-v+$` → **review whether A applies** | A:review(111) / B:115 / C:121 `blank` | A:review / C:127 `blank` |
| pnpm | `pnpm view <pkg> versions --json`; verbose is `--loglevel` → **review A** | A:review(110) / B:114 / C:120 `blank` | A:review / C:127 `blank` |
| winget | `winget show --id <pkg> --versions`; options **not** injected into discovery → **no Fix A** | A:no / B:133,283 / C:137 `enh` | A:no / C:137 `enh` |

## Tier 3 — HTTP-primary discovery with subprocess fallback → A + B + C on fallback

| Tool | Note | Node A / B / C | Python A / C |
|------|------|----------------|--------------|
| ansible | Galaxy v3 API → CLI `ansible-galaxy` fallback injects `galaxyOptions` | A:170 (fallback) / B:172 / C:178 | A:156 (fallback) / C:168 |
| hex | Hex API → `mix hex.info` fallback injects `hexOptions` (`--debug`) | A:184 (fallback) / B:186 / C:190 | A:168 (fallback) / C:179 |

## Tier 4 — HTTP-fetch discovery → Fix A N/A; harden secondary spawnSync (B) + error blocks (C)

Discovery is a pure HTTP fetch (no subprocess), so **Fix A does not apply**.
The `spawnSync`/`subprocess.run` calls listed are the **version-pin** and
**install/resolve test** steps; apply Fix B (Node `maxBuffer`) and Fix C
(signal name) there.

| Tool | Discovery (HTTP) | Node B (spawnSync, no maxBuffer) | Node/Python C |
|------|------------------|----------------------------------|---------------|
| cabal | Hackage `/package/<pkg>.json` | 164, 202 | node 207 `blank`-ish / py 183 |
| cargo | crates.io `/api/v1/crates/<crate>` | 176, 199, 306, 308 | node 204 / py 188 |
| chocolatey | NuGet v2 OData `FindPackagesById()` | 234, 340 | node 244 / py 221 |
| clojars | Clojars JSON + maven-metadata.xml | 243 | node 254 `enh` / py 226 `enh` |
| cpan | MetaCPAN JSON API | 199, 286 | (mostly try/catch; check 286 block) |
| cran | crandb JSON API | 226 | (Rscript version check) |
| dart | pub.dev JSON API | 197, 212, 303 | (check version-check + `pub add`) |
| docker | Docker Hub / registry v2 API | 218, 307 | 221 (version mismatch path) |
| gradle | maven-metadata.xml | 316 | node 324,331 `enh` / py 325 `enh` |
| homebrew | formulae.brew.sh JSON | 298 | node 313 `enh` / py 300 `enh` |
| jsr | JSR meta JSON | 355 | node 367 `enh` / py 334 `enh` |
| maven | maven-metadata.xml | (no spawnSync in discovery; check install path) | — |
| nuget | NuGet v3 flat-container | (no spawnSync in discovery; check install path) | — |
| poetry | PyPI JSON API | (no spawnSync in discovery; check install path) | — |
| puppet | Forge `/v3/modules/<slug>` | 189, 293 | node 197 `blank` / py 185 `blank` |
| stack | Stackage `/package/<pkg>.json` | 192, 304 | node 196 `blank` / py 186 `blank` |
| terraform | Registry JSON API | 179, 297 | node `enh` / py 304 `enh` |
| twine | PyPI JSON API | 216, 309, 335 | node 220 `blank` / py 186 `blank` |
| vagrant | Vagrant Cloud `/api/v1/box/...` | 272 | (returncode-only; no blank-error) |
| vcpkg | vcpkg registry `/versions/<...>.json` | 274 | (returncode-only; no blank-error) |

### Tier 4 priority within the tier
- **Highest** (`blank` error blocks in the version-pin step): `puppet`, `stack`,
  `twine`, `cargo`, `chocolatey`, `cabal`.
- **Medium** (`enh` — already non-blank, surface signal name): `clojars`,
  `gradle`, `homebrew`, `jsr`, `terraform`.
- **Lower** (returncode-only handling, mostly need only Fix B `maxBuffer`):
  `vagrant`, `vcpkg`, `cpan`, `cran`, `dart`, `docker`, `maven`, `nuget`,
  `poetry`.

## Counts
- Tools needing **Fix A**: 8 (Tier 1) + up to 4 special/review (Tier 2) + 2 fallback (Tier 3) = **~10–14**.
- Tools needing **Fix B** (Node `maxBuffer`): **all 34** (every tool has ≥1 output-capturing `spawnSync`).
- Tools needing **Fix C**: **all 34** (× both languages); ~14 are true `blank` bugs, the rest are enhancements.
</content>
