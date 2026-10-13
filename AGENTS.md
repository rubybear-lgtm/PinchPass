# pinchpass — agent guide

Single-purpose Go tool: generate one-time E2E-encrypted secret request links.

## Commands

```sh
go build -o pinchpass .          # build
go vet ./...                    # vet
gofmt -l $(git ls-files '*.go')  # format check
go test -v -count=1 ./...    # run tests (count=1 disables cache)
```

- Go 1.26+ required. Module: `github.com/rubybear-lgtm/pinchpass`
- Only dependency: `golang.org/x/crypto` (nacl/secretbox)

## CI

`.github/workflows/ci.yml` runs on pushes and PRs: the `go` job checks
`gofmt`, `go vet`, `go build`, and `go test -race`; the `npm` job installs with
`--ignore-scripts` (no binary download), typechecks, then `npm test`. Other
workflows: `codeql.yml` (Go + TS scanning), `dependency-review.yml` (PRs),
`scorecard.yml` (OpenSSF), and `release.yml` (tag-triggered build + npm
publish). `pages.yml` deploys `site/` to GitHub Pages on pushes that touch
`site/**`. `dependabot.yml` opens weekly bump PRs for Go, npm, and actions —
keep the `go` directive in `go.mod` in step with the workflow's
`go-version-file`, since `x/crypto` sets the floor.

## CLI quirks

- `pinchpass request <name>` is the full form. Bare `pinchpass <name>` also works (auto-detected in `main.go:46`).
- Flags use single-dash style: `-out`, `-note`, `-ttl`, `-tunnel`, `-json`, `-port`, `-listen-addr`.
- `pinchpass --help` or bare `pinchpass` prints usage. No `--help` on subcommand.
- Default output: `.env`. Default TTL: 30 min. Default listen: `127.0.0.1:random`.
- `-json` flag prints machine-readable JSON (for agent parsing). Human mode prints link and blocks.
- **Blocking**: `pinchpass` blocks until the user submits the secret or the TTL expires.

## Agent skill

A universal skill at `skills/pinchpass/SKILL.md` teaches any agent how to
install and use the `pinchpass` CLI. Install it via [skills.sh](https://skills.sh):

```sh
npx skills add rubybear-lgtm/pinchpass
```

Works with opencode, Claude Code, OpenClaw, Cursor, Windsurf, and 70+ other
agents. No platform-specific plugins needed — the skill is the integration.

## npm / Pi package

- `plugins/pinchpass/` is the `@pinchpass/cli` npm package — dual-mode
  extension: native Pi tool (`request_secret`: `via` modal dialog → direct
  `.env` write, or `via` link → spawns CLI + streams URL) and OpenClaw plugin
  (same tool name, `$.raw` backend).
- `pi` manifest in `package.json`: `dist/index.js` (extension) + `skills/`
  (skill copied from `skills/pinchpass/SKILL.md` by `scripts/copy-skill.js` at build).
- `bin/pinchpass.js` is the package's `bin`: npm's global shim and `npx
  @pinchpass/cli` run it, it resolves the platform binary (installing it on
  first use) and hands off, forwarding stdio, signals, and the exit code. It
  does not version-check on every run — that stays in `npm update -g` /
  `brew upgrade`.
- Build/publish: `cd plugins/pinchpass && npm install && npm publish`.
  `postinstall` (`scripts/install-binary.js`) installs the release asset pinned
  to the package version into `~/.local/bin`, verifying it against the release's
  `checksums.txt`. It is version-aware, so `npm update -g @pinchpass/cli`
  upgrades an existing binary instead of skipping it.
- Test: `cd plugins/pinchpass && npm test` (builds `dist/`, then `node --test`).
- Loading a local build in Pi: `pi install <repo>/plugins/pinchpass` makes Pi
  load `dist/index.js` directly. **`/reload` does not pick up a rebuilt `dist/`**
  — Node's ESM cache serves the module already loaded for that path. Restart Pi
  after rebuilding. (`/reload` only helps the first time, before anything is
  cached.)

## Documentation site

`site/` is a static GitHub Pages site (`index`, `install`, `cli`, `security`,
`agents`, `faq`, `404`) published at <https://rubybear-lgtm.github.io/PinchPass/>.
It has **no build step and no dependencies** — plain HTML plus one
`styles.css` — and `.github/workflows/pages.yml` deploys the directory verbatim
(`upload-pages-artifact` with `path: site`). Pages is configured with
`build_type: workflow`, so it is published only through that workflow; a push to
`master` touching `site/**` triggers a deploy.

- **Never add a CDN, web font, or external script.** The site must stay
  self-contained. Everything it needs lives in `site/`.
- The visual language mirrors the form the tool actually serves: Solarized
  light/dark via `prefers-color-scheme`, the same monospace stack, the same
  animated gradient wordmark (`server/handlers.go` `pageTemplate`). Reuse the
  classes in `site/styles.css` instead of adding CSS, and keep the ASCII hero
  byte-identical to the served art if you touch it.
- Every page carries a unique `<title>`, meta description, canonical URL,
  Open Graph + Twitter cards, and a JSON-LD block — `SoftwareApplication` +
  `WebSite` on the index, `HowTo` on install, `FAQPage` on the FAQ,
  `TechArticle` elsewhere. Keep the FAQ's `mainEntity` questions in step with
  the visible `<details>` questions; the counts must match exactly.
- Add new pages to `site/sitemap.xml`, and keep `robots.txt` pointing at it.
- `404.html` is served by Pages for **every** missing path, so it carries
  `<base href="/PinchPass/">` — without it, relative asset and page links on a
  deep 404 path (for example `/PinchPass/a/b/missing`) resolve against the
  requested directory and the page renders unstyled. Keep that base tag on
  `404.html` only, and update it if the site ever moves to a custom domain.
- The site documents the **current** behaviour of the code. Check claims against
  `server/`, `cmd/`, and `store/` before editing copy: an earlier revision of
  this file described the URL path as a random token, which it never was.

## Releasing

Pushing a `v*` tag runs `release.yml`, which does two things:

1. **GoReleaser** (`.goreleaser.yaml`) builds `linux`/`darwin` × `amd64`/`arm64`
   as **raw binaries** named `pinchpass-<os>-<arch>` (the names the npm
   installer and the documented curl commands depend on), writes
   `checksums.txt` (SHA-256), and commits `Casks/pinchpass.rb` to
   `rubybear-lgtm/homebrew-tap`. It needs the `HOMEBREW_TAP_TOKEN` secret — a
   fine-grained PAT or GitHub App token with `contents: write` on the tap repo;
   the default `GITHUB_TOKEN` cannot push to another repository.
2. **npm** publishes `@pinchpass/cli` via **Trusted Publishing (OIDC)**
   (`npm publish --provenance`) — no `NPM_TOKEN` secret needed; the npm package
   must have `rubybear-lgtm/PinchPass` (workflow `release.yml`) configured as a
   trusted publisher in the npm web UI.

The version is injected with
`-ldflags "-X .../version.Number={{ .Version }} -X .../version.Revision={{ .ShortCommit }}"`;
`go install ...@latest` instead reports the module version from
`runtime/debug.ReadBuildInfo()`. `pinchpass --version` (or `pinchpass version`)
prints it. `goreleaser check` runs in CI to keep the config valid — `brews` is
deprecated, so the tap ships a **cask**: `brew install --cask
rubybear-lgtm/tap/pinchpass`.

## Architecture

- `main.go` entrypoint → delegates to `cmd.RunRequest()`.
- `version/` resolves the build version from `-ldflags` or Go build info;
  `pinchpass --version` and `pinchpass version` print it.
- `server.Start()` serves the HTML form with embedded TweetNaCl.js at
  `/claim/<path>`; every other path 404s, and any method other than GET/POST on
  the claim path returns 405.
- **The URL path is not a token.** `makePath()` (`server/server.go:14`) derives
  it from the secret names — lowercased, keeping only `[a-z0-9_]`, joined with
  `_`, truncated to 80 characters — so `GEMINI_API_KEY` becomes
  `/claim/gemini_api_key`. Treat the name as public.
- Encryption key: 32 random bytes from `crypto/rand`, **base64url** encoded (43
  characters), carried in the URL fragment (`#k=<key>`). **Never sent to the
  server** — the browser refuses to submit unless the fragment matches
  `^#k=([A-Za-z0-9_-]{43})$`, and disables the button when it does not.
- POST body: `value=<base64(nonce[24] || nacl.secretbox(...))>` as `application/x-www-form-urlencoded`.
- `server.Wait()` blocks until submit or TTL; then CLI decrypts blob and writes to `.env`.
- bore.pub tunnel connects to `bore.pub:7835` (hardcoded in `tunnel/bore.go:13-14`).
- Public URL format: `http://bore.pub:<remote-port>/claim/<path>#k=<key>`.
- One-time use: the first accepted POST claims the request; every later request
  (GET or POST) returns 404 with the link-expired page.
- TTL expiry shuts down the HTTP server.

## Test notes

- `TestBoreTunnelSmoke` auto-skips if bore.pub is unreachable.
- Integration tests start real HTTP servers on random ports.
- Test helpers `encryptBlob`/`decryptBlob` in `pinchpass_test.go` replicate the browser crypto flow.

## .env output

- Shell-escaped (`\`, `"`, `$`, `` ` ``). Overwrites existing key in place.
- Creates parent directories of the output path.

## Security

- The URL path is **not** secret material — it is derived from the secret name
  (see Architecture). The encryption key is the only secret in the flow.
- The key is 32 random bytes from `crypto/rand`, base64url-encoded, delivered
  only in the URL fragment.
- Confidentiality comes from XSalsa20-Poly1305, not from the path. A stale or
  hostile POST simply fails to decrypt; the CLI reports
  `decryption failed (tampered payload?)`.
- One-time use plus the TTL bound the exposure window, and the server binds
  `127.0.0.1` unless `-listen-addr` says otherwise.
- Minimum encrypted blob size check: 41 bytes (24 nonce + 16 mac + 1 ciphertext).
- `token.Validate()` in `token/token.go` is **dead code** — nothing calls it, and
  `handleClaim` compares the path with a plain `!=`. That is acceptable only
  because the path is not a secret; do not describe it as a constant-time
  compared token.
