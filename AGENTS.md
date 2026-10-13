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
publish). `dependabot.yml` opens weekly bump PRs for Go, npm, and actions —
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
- `server.Start()` creates HTTP server with one valid token. Serves HTML form with embedded TweetNaCl.js at `/claim/<token>`.
- Encryption key is in URL fragment (`#k=<hex>`). **Never sent to server.**
- POST body: `value=<base64(nonce[24] || nacl.secretbox(...))>` as `application/x-www-form-urlencoded`.
- `server.Wait()` blocks until submit or TTL; then CLI decrypts blob and writes to `.env`.
- bore.pub tunnel connects to `bore.pub:7835` (hardcoded in `tunnel/bore.go:13-14`).
- Public URL format: `http://bore.pub:<remote-port>/claim/<token>#k=<hex>`.
- One-time use: first POST claims the token; all subsequent requests return 404.
- TTL expiry shuts down the HTTP server.

## Test notes

- `TestBoreTunnelSmoke` auto-skips if bore.pub is unreachable.
- Integration tests start real HTTP servers on random ports.
- Test helpers `encryptBlob`/`decryptBlob` in `pinchpass_test.go` replicate the browser crypto flow.

## .env output

- Shell-escaped (`\`, `"`, `$`, `` ` ``). Overwrites existing key in place.
- Creates parent directories of the output path.

## Security

- Both auth token (URL path) and encryption key (URL fragment) are 32 random bytes via `crypto/rand`.
- Token comparison uses `subtle.ConstantTimeCompare`.
- Minimum encrypted blob size check: 41 bytes (24 nonce + 16 mac + 1 ciphertext).
