# PinchPass

<p align="center">
  <img src="pinchpass.png" alt="PinchPass — a claw pinching a briefcase" width="420">
</p>

<p align="center">
  <strong>One-time, end-to-end encrypted secret request links.</strong><br>
  Ask a human for an API key without the value touching the relay, the logs,
  or the agent's context window.
</p>

<p align="center">
  <a href="https://github.com/rubybear-lgtm/PinchPass/actions/workflows/ci.yml"><img src="https://github.com/rubybear-lgtm/PinchPass/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@pinchpass/cli"><img src="https://img.shields.io/npm/v/@pinchpass/cli" alt="npm version"></a>
  <a href="https://github.com/rubybear-lgtm/PinchPass/releases/latest"><img src="https://img.shields.io/github/v/release/rubybear-lgtm/PinchPass" alt="latest release"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license">
  <img src="https://img.shields.io/badge/Go-1.26%2B-00ADD8.svg" alt="Go 1.26 or newer">
</p>

PinchPass collects sensitive values — API keys, tokens, passwords — from a
human, either through a **native dialog** or a **one-time E2E-encrypted browser
link**, and writes them straight into `.env`. It is built for AI agents that
need a credential they do not have, and it works locally or over the internet
through a built-in `bore.pub` tunnel.

**The relay never sees the secret.** In the link flow, values are encrypted in
the browser with XSalsa20-Poly1305 (TweetNaCl) before transmission, and the
decryption key lives only in the URL fragment — never sent to the server or the
tunnel relay. In the dialog flow, the value goes straight from the user's
keyboard into `.env`: it never reaches the model, never enters the session
transcript, and no server is started at all.

📖 **Documentation: <https://rubybear-lgtm.github.io/PinchPass/>** —
[install](https://rubybear-lgtm.github.io/PinchPass/install.html) ·
[CLI reference](https://rubybear-lgtm.github.io/PinchPass/cli.html) ·
[security model](https://rubybear-lgtm.github.io/PinchPass/security.html) ·
[agent integration](https://rubybear-lgtm.github.io/PinchPass/agents.html) ·
[FAQ](https://rubybear-lgtm.github.io/PinchPass/faq.html)

## Contents

- [Why this exists](#why-this-exists)
- [Two ways to collect a secret](#two-ways-to-collect-a-secret)
- [Pi integration](#pi-integration)
- [How the link flow works](#how-the-link-flow-works)
- [Install](#install)
- [Updating](#updating)
- [Usage](#usage)
- [Flags](#flags)
- [Output](#output)
- [The tunnel](#the-tunnel)
- [Security model](#security-model)
- [Agent skill](#agent-skill)
- [Build](#build)
- [Project structure](#project-structure)
- [Tests](#tests)
- [FAQ](#faq)
- [License](#license)

## Why this exists

An agent hits a step that needs a credential it does not have. Every obvious
answer leaks it somewhere:

| Approach | What goes wrong |
|---|---|
| Paste it into the chat | The plaintext lands in the session transcript, which is stored, replayed as context, and often synced to a model provider. |
| Hand over a file to read | The agent now holds a copy, and so does every log line that echoes it. |
| Use a hosted secret-sharing service | The vendor's servers hold your plaintext, and you need an account to use it. |
| Type it into a relay's form | If the relay terminates the crypto, the relay sees the secret. |

PinchPass closes the loop. The human's keyboard is the only place the value
exists in plaintext outside your own machine, and the final hop is one-time,
expiring, and readable by exactly one process.

## Two ways to collect a secret

| Mode | How it works | When to use |
|---|---|---|
| **Dialog** | A native Pi overlay collects each value straight into `.env`. Keyboard → disk. No server, no network, no binary required. `ttl` does not apply. | An interactive Pi session where the human is already present. |
| **Link** | Starts a one-time HTTP server on a random loopback port and prints a URL. Add `-tunnel` for a public `bore.pub` address. Encrypted in the browser. | Remote humans, tunneled sessions, and any client without a dialog UI. |

The link is:

- **One-time** — the first accepted submission claims the request; every later
  request returns `404`
- **End-to-end encrypted** — ciphertext in flight, key in the URL fragment only
- **Time-limited** — expires after the TTL (default 30 min)
- **Loopback by default** — binds `127.0.0.1` unless you ask for a tunnel
- **Install-free for the sender** — one self-contained page, no WebCrypto, no
  HTTPS, no account

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
- The same package also works on **OpenClaw** (same tool name, `$.raw` backend),
  and the universal skill works on 70+ agents via skills.sh.

## How the link flow works

```
Agent runs:   pinchpass request GEMINI_API_KEY -tunnel -note "Production API key"
              → http://bore.pub:38448/claim/gemini_api_key#k=<43-char key>

User opens    → form with embedded TweetNaCl.js crypto (no WebCrypto required)
User submits  → browser encrypts value, POSTs ciphertext to the server
Agent knows   → decrypts locally with the key it kept in memory, writes .env ✅
```

What crosses the wire is base64 of the 24-byte nonce concatenated with the
secretbox output — never the plaintext and never the key.

## Install

```bash
# Homebrew (macOS and Linux, via the tap)
brew install --cask rubybear-lgtm/tap/pinchpass
```

```bash
# Pi (native package — registers the request_secret tool and the skill)
pi install npm:@pinchpass/cli
```

```bash
# Any agent (npm — provides the `pinchpass` command)
npm i -g @pinchpass/cli
```

```bash
# No install needed (npx fetches the package and binary on first use)
npx @pinchpass/cli request API_KEY
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
# From source (requires Go 1.26+)
go install github.com/rubybear-lgtm/pinchpass@latest
```

Releases publish `linux` and `darwin` builds for `amd64` and `arm64`. Windows
is not a published target.

## Updating

```bash
pinchpass --version   # pinchpass v1.2.0 (abc1234)
```

Update through whichever channel you installed with:

| Installed with | Update with |
|----------------|-------------|
| Homebrew | `brew upgrade --cask pinchpass` |
| npm | `npm update -g @pinchpass/cli` — updates the package; the postinstall replaces the binary when the version differs |
| `go install` | `go install github.com/rubybear-lgtm/pinchpass@latest` |
| curl | re-run the `curl` command above |

Releases publish a `checksums.txt` (SHA-256) alongside the binaries, and the
npm postinstall verifies its download against it before installing.

## Usage

```bash
# Local link (this machine only)
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

Flags use single-dash style (`-out`, not `--out`). `pinchpass --help` prints
usage; there is no `--help` on the subcommand.

## Output

The secret is saved to a `.env` file (default: `.env`):

```env
API_KEY="sk-..."
```

The value is double-quoted and shell-escaped (`\`, `"`, `$`, `` ` ``), existing
keys are replaced in place, and the file is written with `0600` permissions.
Parent directories are created with `0700`.

With `-json`, two objects are printed — one before the command blocks, carrying
the `url`, and one after, carrying `success`:

```json
{
  "success": true,
  "names": ["GEMINI_API_KEY"],
  "message": "Secret request link (one-time, expires in 30 min)",
  "url": "http://bore.pub:38448/claim/gemini_api_key#k=...",
  "port": 38448
}
```

A timeout exits non-zero, writes nothing, and reports `"success": false`.

## The tunnel

`-tunnel` dials `bore.pub:7835` with a native, pure-standard-library client —
there is no `bore` binary to install — and prints:

```
http://bore.pub:<remote-port>/claim/<path>#k=<key>
```

Share the whole URL, fragment included: everything after `#` is the decryption
key, and browsers never transmit it. If a chat client or shortener strips the
fragment, the form disables submit and the human needs a fresh link.

## Security model

```
Browser                     Server (local)          Bore relay
  │                               │                       │
  │  key = URL fragment (#k=…)    │                       │
  │  nonce = nacl.randomBytes(24) │                       │
  │  box = nacl.secretbox(val,…)  │                       │
  │                               │                       │
  │ ── POST base64(nonce ‖ box) ──┼──── ciphertext ─────► │
  │                               │                       │
  │        (key never sent)       │                       │
  │                               │
  │                     CLI decrypts with the key held in memory
  │                     Writes shell-escaped plaintext to .env
```

- **Cipher** — XSalsa20-Poly1305: TweetNaCl.js in the browser,
  `golang.org/x/crypto/nacl/secretbox` in Go
- **Key** — 32 random bytes from `crypto/rand`, base64url-encoded (43 chars),
  delivered **only** in the URL fragment, which browsers never transmit
- **Nonce** — 24 bytes per submission, prepended to the ciphertext
- **Minimum blob** — 41 bytes (24 nonce + 16 MAC + ≥1 ciphertext); shorter
  payloads are rejected with `400`
- **One-time** — the first accepted submission claims the request; every later
  request to that URL returns `404`
- **Expiry** — the server shuts down at the TTL, and nothing is written
- **Works over plain HTTP** — the payload is already encrypted, so no HTTPS or
  WebCrypto is required

**The request path is not a secret.** PinchPass derives it from the secret name
— lowercased, keeping only `a`–`z`, `0`–`9` and `_`, joined with `_`, truncated
to 80 characters — so `GEMINI_API_KEY` becomes `/claim/gemini_api_key`. Treat
the **name** as public and the **value** as protected: submitting anything
requires producing ciphertext under a key that only the URL fragment carries.

What this does **not** protect against: a compromised machine or a malicious
browser extension, the plaintext once it is on disk, and loss of the URL — there
is no escrow and no recovery, so the human must resubmit. See the
[security model](https://rubybear-lgtm.github.io/PinchPass/security.html) for
the full threat model, including what the relay can observe.

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

## Build

```bash
go build -o pinchpass .
```

Requires Go 1.26+. Module: `github.com/rubybear-lgtm/pinchpass`. The only
dependency is `golang.org/x/crypto` (nacl/secretbox).

## Project structure

```
├── main.go                    # Entry point
├── cmd/request.go             # CLI subcommand + nacl decryption
├── server/
│   ├── server.go              # HTTP server lifecycle
│   └── handlers.go            # Form (TweetNaCl embedded) + handlers
├── tunnel/bore.go             # Native bore.pub client (pure stdlib)
├── token/token.go             # Key generation
├── store/store.go             # .env writer
├── pinchpass_test.go          # Integration tests
├── site/                      # Documentation site (GitHub Pages)
├── plugins/pinchpass/         # @pinchpass/cli npm package (Pi + OpenClaw)
└── skills/pinchpass/SKILL.md  # Universal agent skill (skills.sh)
```

## Tests

```bash
go test -v -count=1 ./...
```

The bore tunnel smoke test (`TestBoreTunnelSmoke`) is skipped automatically if
bore.pub is unreachable.

## FAQ

**Does the relay see my secret?**
No. It forwards ciphertext and never receives the key, which lives in the URL
fragment. It can observe metadata: that a request happened, its size, its
timing, and the request path.

**Is HTTPS or WebCrypto required?**
No. The browser encrypts with embedded TweetNaCl.js, so plain HTTP is safe for
the value itself. HTTPS would additionally hide request metadata from a network
observer.

**Can I reuse a link?**
No. The first accepted submission claims it, and every later request returns
`404`. Run the command again for a fresh link and a fresh key.

**Can I recover a secret if I lose the URL?**
No. There is no escrow — the key exists only in that fragment. Ask the human to
submit again on a new link.

**What happens if the human never submits?**
The server shuts down at the TTL (default 30 minutes), the CLI exits non-zero,
and nothing is written.

**Does it work on Windows?**
Not as a published target. Releases cover Linux and macOS on `amd64` and
`arm64`.

More answers in the [FAQ](https://rubybear-lgtm.github.io/PinchPass/faq.html).

## License

MIT
