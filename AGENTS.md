# pinchpass — agent guide

Single-purpose Go tool: generate one-time E2E-encrypted secret request links.

## Commands

```sh
go build -o pinchpass .          # build
go test -v -count=1 ./...    # run tests (count=1 disables cache)
```

- Go 1.25+ required. Module: `github.com/rubybear-lgtm/pinchpass`
- Only dependency: `golang.org/x/crypto` (nacl/secretbox)

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

## Architecture

- `main.go` entrypoint → delegates to `cmd.RunRequest()`.
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
