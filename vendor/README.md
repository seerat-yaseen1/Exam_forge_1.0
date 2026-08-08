# vendor/

Third-party packages committed as bytes rather than resolved from a network.

Right now that means one: **SheetJS (`xlsx`) 0.20.3**.

## Why xlsx is here

SheetJS stopped publishing to the npm registry after 0.19. The current release
is distributed only from `cdn.sheetjs.com`, so `package.json` pinned a URL — and
a URL dependency has three problems that surfaced together when CI first ran a
clean install:

- **It cannot be installed where that host is unreachable.** A locked-down
  runner, a corporate proxy or an air-gapped build has no route to it, and the
  install fails outright rather than degrading.
- **It is re-fetched on every resolution.** URL deps are not served from the
  package store, so a CDN outage becomes a build outage.
- **Nothing verifies the bytes.** A URL says where to get a dependency, not what
  it should be.

Vendoring answers all three: the tarball lives in this repository, the pin
becomes `file:vendor/xlsx-0.20.3.tgz`, and pnpm records an integrity hash for it
in the lockfile.

Staying on 0.20.3 is deliberate. Dropping to the registry's last version, 0.18.5,
would make the resolver happy by shipping an older library — a packaging problem
solved by changing what the product runs, which is the wrong direction.

## Doing it

```bash
npm run vendor:xlsx     # downloads, verifies, writes here, flips the pin
pnpm install            # regenerates pnpm-lock.yaml with the integrity hash
git add vendor package.json pnpm-lock.yaml
```

The script must run somewhere `cdn.sheetjs.com` is reachable. That is the whole
point: it needs network access **once**, and never again on any other machine.

## The hash

`xlsx-0.20.3.sha256` sits beside the tarball, and every later run of the script
verifies against it. The first run has nothing to verify against and says so
loudly — **check that hash against SheetJS's published checksum before
committing it**, because an unchecked hash there is an unchecked dependency
from then on.

A mismatch on a later run means the CDN is serving different bytes than this
repository was built against. Establish why before touching the recorded hash.

## Size

The tarball is a few megabytes and this is a normal cost of vendoring. It is
committed once and changes only on a deliberate upgrade, so it does not grow
with ordinary work. Git LFS would be the answer if this directory ever held
several such packages; for one, it is not worth the setup.
