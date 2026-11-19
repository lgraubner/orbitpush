# Changelog

User-visible changes to orbitpush: commands, flags, exit codes, terminal output, and the `orbitpush.json` format. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Removed

- **Breaking:** `init` no longer takes `--domain` and `--alias`. Add domains after `init` with `orbitpush domains add <host>`, or list them in `orbitpush.json` before `deploy`.

### Changed

- `domains add` looks up the DNS record itself and prints the expected record next to the current one, whether or not they match. A CNAME that leads to another bunny.net pull zone no longer counts as done: `domains add` waits for it to change, and without a terminal it exits `1`, even for a domain that is already connected.
- `deploy` prints no DNS records. A domain that bunny.net refuses a certificate for gets one warning after the deploy, pointing to `orbitpush domains add <host>`.
- A failed bunny.net request reads `Could not <action>: bunny.net says "<message>"` instead of the request's method, path and HTTP status. Set `ORBITPUSH_DEBUG=1` to print those too.
- When a domain is already on another pull zone, `domains add` and `deploy` name that pull zone and link its hostnames in the dashboard, or say that another bunny.net account uses the domain.

## 0.2.0 - 2026-11-18

### Changed

- `deploy` deletes stale HTML pages, PDFs, images and other files on the deploy that drops them, so a removed page stops being served right away. Only stale `.js`, `.mjs`, `.css`, `.wasm`, `.json`, font and source map files, which open pages of the previous build can still request, stay for 7 days. Without an `index.html` in the output, deploy deletes stale files only after 7 days.

## 0.1.1 - 2026-11-10

### Changed

- Releases are published from GitHub Actions through npm trusted publishing, with provenance. The CLI itself is unchanged.

## 0.1.0 - 2026-11-10

### Added

- First release: `init`, `deploy`, `domains`, `migrate-netlify`, `disable`, `enable`, and `destroy`, which deploy a static site to your own bunny.net storage zone and pull zone.
