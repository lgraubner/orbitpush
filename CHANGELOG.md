# Changelog

User-visible changes to orbitpush: commands, flags, exit codes, terminal output, and the `orbitpush.json` format. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.4.0 - 2026-11-20

### Changed

- Each deploy now places the edge rules from orbitpush after the edge rules you created in the dashboard. A dashboard redirect wins over an orbitpush redirect for the same URL, and an orbitpush header wins over a dashboard header. Before, the two shared order indexes, and which rule ran first was undefined.

### Fixed

- `domains add` and `deploy` no longer fail with `Could not write an edge rule: bunny.net says "Order index must be unique"` when a new alias, redirect or header lands ahead of rules already deployed, or on an `OrderIndex` a rule created in the dashboard holds.
- `domains add` no longer asks you to change a DNS record that bunny.net accepted when it issued the certificate, such as a root domain whose ALIAS or flattened CNAME resolves to a different bunny.net address than the public resolvers see.
- `domains add` and `deploy` show a status line while bunny.net issues an SSL certificate, instead of pausing without output.

## 0.3.0 - 2026-11-19

### Removed

- **Breaking:** `init` no longer takes `--domain` and `--alias`. Add domains after `init` with `orbitpush domains add <host>`, or list them in `orbitpush.json` before `deploy`.

### Changed

- `domains add` looks up the DNS record itself and prints the expected record next to the current one, whether or not they match. A CNAME that leads to another bunny.net pull zone no longer counts as done: `domains add` waits for it to change, and without a terminal it exits `1`, even for a domain that is already connected.
- `deploy` prints no DNS records. A domain that bunny.net refuses a certificate for gets one warning after the deploy, pointing to `orbitpush domains add <host>`.
- `init` and the first `deploy` check that the project name is free on bunny.net before creating anything. A taken name asks again at the prompt and stops with `The name "<name>" is already taken on bunny.net. Choose another with --name.` without one, instead of creating a storage zone and deleting it again.
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
