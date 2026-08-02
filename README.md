# PinchPass

<p align="center">
  <img src="pinchpass.png" alt="pinchpass" width="500" style="border:1px solid #d0d7de;border-radius:8px;">
</p>

Collect sensitive values (API keys, tokens, passwords) from users — either
through a **native Pi modal dialog** or a **one-time E2E-encrypted browser
link**. Built for AI agents, works locally and over the internet via a built-in
bore.pub tunnel.

**The relay never sees the secret.** In the link flow, secrets are encrypted
client-side in the browser before transmission using XSalsa20-Poly1305
(TweetNaCl). The encryption key lives only in the URL fragment — it is never
sent to the server or the tunnel relay. In the Pi modal flow, the value goes
straight from the user's keyboard into `.env` — it never reaches the LLM, never
enters the session transcript, and no server is started at all.

## Pi integration

PinchPass ships as a native [Pi](https://pi.dev) package:

```bash
pi install npm:@pinchpass/cli
```

(The package is `@pinchpass/cli` — the install also downloads the prebuilt
`pinchpass` binary for your platform.)

This registers a **`request_secret`** tool with two collection modes:

| via | Behavior |
|-----|----------|
| `modal` | **Pi dialog** (default in the interactive TUI): a branded, masked overlay collects each secret directly into `.env`. The value goes keyboard → disk: never to the LLM, never into the transcript, no server, no binary required. Cancelable with `Esc` / `Ctrl+C`. |
| `link` | Starts a local pinchpass server and streams a **one-time E2E-encrypted browser link** to the user immediately; blocks until they submit or the TTL expires. Use for remote/tunneled sessions or clients without a dialog UI. |
| `auto` | Modal in the TUI, link everywhere else (default). |

The modal looks like this:

```
                   ___ ___ _  _  ___ _  _ ___  _   ___ ___
                  | _ \_ _| \| |/ __| || | _ \/_\ / __/ __|
                  |  _/| || .` | (__| __ |  _/ _ \\__ \__ \
                  |_| |___|_|\_|\___|_||_|_|/_/ \_\___/___/
                   🔐  GEMINI_API_KEY

🔐 pinchpass    ┌────────────────────────────────────────────┐
                │  •••••••••••••█                            │
                └────────────────────────────────────────────┘
                enter submit    esc cancel
```

Tool results render as styled cards (`✅ Secrets collected`, `✋ Cancelled`,
`❌ Failed`) with the saved path and key names.

- The binary is resolved from `PATH`, `~/.local/bin`, `~/.openclaw/bin`, and
  `~/.pi/bin` — no PATH configuration required (and not needed for modal mode).
- The same package also works on **OpenClaw** (same tool name), and the
  universal skill works on 70+ agents via skills.sh.

## How the link flow works

```
Agent runs:   pinchpass request API_KEY -tunnel -note "Production API key"
              → http://bore.pub:38448/claim/abc123…#k=a1b2c3…

User opens    → form with embedded TweetNaCl.js crypto (no WebCrypto required)
User submits  → browser encrypts value, POSTs ciphertext to server
Agent knows   → decrypts locally, writes to .env ✅
```

The link is:

- **One-time** — single use, invalidated after first submission
- **E2E encrypted** — key in URL fragment, never leaves the browser
- **Time-limited** — expires after TTL (default 30 min)
- **Token-authenticated** — 32-byte random hex token in the URL path
- **Works anywhere** — local or public via bore.pub tunnel (no install required)

## Install the CLI

```bash
# Any agent (npm — downloads the prebuilt binary for your platform)
npm i -g @pinchpass/cli
```

```bash
# Prebuilt binary directly
curl -sL https://github.com/rubybear-lgtm/PinchPass/releases/latest/download/pinchpass-darwin-arm64 -o /usr/local/bin/pinchpass
chmod +x /usr/local/bin/pinchpass
# macOS (Intel) — use pinchpass-darwin-amd64
# Linux (x86_64) — use pinchpass-linux-amd64
# Linux (arm64)  — use pinchpass-linux-arm64
```

```bash
# From source (requires Go 1.25+)
go install github.com/rubybear-lgtm/pinchpass@latest
```

## Usage

```bash
# Local link (LAN only)
pinchpass request API_KEY

# Public link via bore.pub tunnel
pinchpass request API_KEY -tunnel

# With note and custom output file
pinchpass request API_KEY -note "Production API key" -out config/secrets.env

# JSON output for agent parsing
pinchpass request API_KEY -json

# Custom TTL (minutes)
pinchpass request API_KEY -ttl 5

# Collect multiple secrets at once
pinchpass request DB_HOST DB_PORT DB_NAME -out .env
```

Bare `pinchpass <name>` also works (auto-detected as `request <name>`):

```bash
pinchpass WEBHOOK_SECRET -tunnel -json
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-tunnel` | false | Open a bore.pub tunnel for a public URL |
| `-note` | — | Description shown on the form |
| `-out` | `.env` | Output file path |
| `-ttl` | 30 | Minutes until the link expires |
| `-port` | random | Local port to bind |
| `-listen-addr` | `127.0.0.1` | Address to listen on |
| `-json` | false | Machine-readable output |

## Output

The secret is saved to a `.env` file (default: `.env`):

```env
API_KEY="sk-..."
```

The value is shell-escaped. Existing keys are overwritten in place.

## Security model

```
Browser                        Server (local)        Bore relay
  │                                  │                    │
  │  key = URL fragment (#k=…)       │                    │
  │  nonce = crypto.getRandomValues  │                    │
  │  box = nacl.secretbox(val, …)    │                    │
  │                                  │                    │
  │ ── POST base64(nonce ‖ box) ───► │ ── ciphertext ──► │
  │                                  │                    │
  │           (key never sent)       │                    │
  │                                  │
  │                              CLI decrypts with key from URL fragment
  │                              Writes plaintext to .env
```

- Cipher: **XSalsa20-Poly1305** (TweetNaCl.js in browser, `golang.org/x/crypto/nacl/secretbox` in Go)
- Key: 32 random bytes generated by the CLI, delivered via URL fragment only
- Works on plain HTTP — no HTTPS or WebCrypto required

## Build

```bash
go build -o pinchpass .
```

Requires Go 1.25+. Module: `github.com/rubybear-lgtm/pinchpass`. Only
dependency: `golang.org/x/crypto` (nacl/secretbox).

## Project structure

```
├── main.go                    # Entry point
├── cmd/request.go             # CLI subcommand + nacl decryption
├── server/
│   ├── server.go              # HTTP server lifecycle
│   └── handlers.go            # Form (TweetNaCl embedded) + handlers
├── tunnel/bore.go             # Native bore.pub client (pure stdlib)
├── token/token.go             # One-time token generation
├── store/store.go             # .env writer
├── pinchpass_test.go          # Integration tests
├── plugins/pinchpass/         # @pinchpass/cli npm package (Pi + OpenClaw)
└── skills/pinchpass/SKILL.md  # Universal agent skill (skills.sh)
```

## Tests

```bash
go test -v -count=1 ./...
```

The bore tunnel smoke test (`TestBoreTunnelSmoke`) is skipped automatically if bore.pub is unreachable.

## Agent skill

This repo includes a universal skill at `skills/pinchpass/SKILL.md` that teaches
any AI agent how to install and use `pinchpass`. Install it via
[skills.sh](https://skills.sh):

```bash
npx skills add rubybear-lgtm/pinchpass
```

Works with opencode, Claude Code, OpenClaw, Cursor, Windsurf, Gemini, and 70+
other agents.

### Install to specific agents

```bash
npx skills add rubybear-lgtm/pinchpass -a opencode -a claude-code -a openclaw
```

### Global install (available across all projects)

```bash
npx skills add rubybear-lgtm/pinchpass -g
```

## License

MIT
