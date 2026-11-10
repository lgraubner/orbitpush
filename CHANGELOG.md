# Changelog

User-visible changes to orbitpush: commands, flags, exit codes, terminal output, and the `orbitpush.json` format. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.1.1 - 2026-11-10

### Changed

- Releases are published from GitHub Actions through npm trusted publishing, with provenance. The CLI itself is unchanged.

## 0.1.0 - 2026-11-10

### Added

- First release: `init`, `deploy`, `domains`, `migrate-netlify`, `disable`, `enable`, and `destroy`, which deploy a static site to your own bunny.net storage zone and pull zone.
