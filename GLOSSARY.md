# orbitpush

A CLI that deploys a static site or SPA to the user's own bunny.net account: a storage zone with a pull zone in front, under the user's own API key.

## Language

**Storage zone**:
The bunny.net file store that holds the deployed files. Created by `init` with the project name; its main region is fixed after that.
_Avoid_: bucket, origin

**Pull zone**:
The bunny.net CDN in front of the storage zone, reachable at `<name>.b-cdn.net`, the custom domain and its aliases.
_Avoid_: CDN zone, site

**Output directory**:
The build output that `deploy` uploads, set as `outputDir` in `orbitpush.json`. `_headers` and `_redirects` in its root are read, not uploaded.
_Avoid_: dist, build folder

**Edge rule**:
A bunny.net pull zone rule that matches a URL pattern and redirects or sets response headers. Each redirect line and each `_headers` path block becomes one.

**Managed rule**:
An edge rule whose description starts with `orbitpush <hash>`. Only managed rules are written or deleted on deploy; rules created in the dashboard are never touched. The hash covers the rule's content, so a changed rule is a new managed rule. Its `OrderIndex` is its position in the rule files, outside the hash. Every deploy rewrites each managed rule still in the files, which undoes dashboard edits to it and moves it to its current position.

**SPA mode**:
The storage zone setting that serves `index.html` with status 200 for a missing path without a file extension. The line `/* /index.html 200` in `_redirects` turns it on; it is the only rewrite orbitpush supports, and it is not an edge rule.
_Avoid_: SPA fallback, `spa` option

**Trailing slash mode**:
The `trailingSlash` setting: `always` redirects `/guides` to `/guides/`, `never` the other way, `ignore` does neither. One managed rule, default `always`, or `ignore` in SPA mode.
_Avoid_: pretty URLs, which on Netlify also serve `/about.html` at `/about/`

**Custom domain**:
The one hostname in `domain` that serves the site. Every other hostname of the site is an alias.
_Avoid_: main domain, primary domain

**Alias**:
A hostname in `aliases` that is added to the pull zone with SSL and 301-redirects to the custom domain, keeping path and query string.
_Avoid_: secondary domain, redirect domain

**Disabled site**:
A pull zone with the edge rule `orbitpush disabled`, which blocks every request. `disable` adds it, `enable` removes it, and `deploy` leaves it in place. The rule on the pull zone is the only record of the state.
_Avoid_: paused, suspended

**Stale file**:
A file in the storage zone that is no longer in the output directory. Deleted after the upload, not before.

**Replication region**:
An extra storage region that mirrors the storage zone. bunny.net can add them but not remove them.

**Geo zone**:
A CDN delivery region of the pull zone: `EU`, `US`, `ASIA`, `SA`, `AF`. User-facing text calls it a delivery region.
