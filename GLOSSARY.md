# orbitpush

A CLI that deploys a static site or SPA to the user's own bunny.net account: a storage zone with a pull zone in front, under the user's own API key.

## Language

**Storage zone**:
The bunny.net file store that holds the deployed files. Created by `init` with the project name; its main region is fixed after that.
_Avoid_: bucket, origin

**Pull zone**:
The bunny.net CDN in front of the storage zone, reachable at `<name>.b-cdn.net` and at each custom domain.
_Avoid_: CDN zone, site

**Output directory**:
The build output that `deploy` uploads, set as `outputDir` in `orbitpush.json`. `_headers` and `_redirects` in its root are read, not uploaded.
_Avoid_: dist, build folder

**Edge rule**:
A bunny.net pull zone rule that matches a URL pattern and redirects or sets response headers. Each redirect line and each `_headers` path block becomes one.

**Managed rule**:
An edge rule whose description starts with `orbitpush <hash>`. Only managed rules are added or deleted on deploy; rules created in the dashboard are never touched. The hash covers the rule's content, so a changed rule is a new managed rule.

**Stale file**:
A file in the storage zone that is no longer in the output directory. Deleted after the upload, not before.

**Replication region**:
An extra storage region that mirrors the storage zone. bunny.net can add them but not remove them.

**Geo zone**:
A CDN delivery region of the pull zone: `EU`, `US`, `ASIA`, `SA`, `AF`. User-facing text calls it a delivery region.
