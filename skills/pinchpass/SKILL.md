---
name: pinchpass
description: "Collect sensitive values (API keys, tokens, passwords, credentials) from the user via a one-time E2E-encrypted link. Use when you need a secret the user hasn't provided, when populating a .env file with credentials, or when the user says they need to give you a key/token/password. "
---

Securely collect sensitive values from users with end-to-end encryption. The
relay server never sees the plaintext — encryption happens in the browser, and
the decryption key lives only in the URL fragment (never sent to the server).

## When to use

- An agent needs a value it does not have (API key, token, password, etc.)
- The user says "I need to give you a secret" or "where do I put my key?"
- A `.env` file needs to be populated with credentials

Do **not** use for non-sensitive plaintext — there is no reason to go through
E2E encryption for a public value. Just ask the user to paste it directly.

## Install

Check that `pinchpass` is available:

```bash
which pinchpass
```

If missing, install it (pick one):

```bash
# Pi (native package — registers the request_secret tool and this skill)
pi install npm:@pinchpass/cli
```

```bash
# Any agent (npm — downloads the prebuilt binary)
npm i -g @pinchpass/cli
```

```bash
# From source (requires Go 1.25+)
go install github.com/rubybear-lgtm/pinchpass@latest
```

```bash
# Prebuilt binary — pick the right platform/arch from:
# https://github.com/rubybear-lgtm/PinchPass/releases
curl -sL https://github.com/rubybear-lgtm/PinchPass/releases/latest/download/pinchpass-darwin-arm64 -o /usr/local/bin/pinchpass
chmod +x /usr/local/bin/pinchpass
```

## Usage

Always use `-json` mode so you can parse the output programmatically.

```bash
pinchpass request <secret-name>... [flags]
```

Bare `pinchpass <name>` also works (auto-detects missing subcommand).

### Collect a single secret

```bash
pinchpass request SECRET_NAME -json
```

### Collect multiple secrets at once

```bash
pinchpass request KEY_A KEY_B KEY_C -json
```

### Create a public link via tunnel

```bash
pinchpass request SECRET_NAME -tunnel -json
```

Use `-tunnel` when the user is not on the same machine (the default binds to
`127.0.0.1` only).

### All flags

| Flag           | Default       | Description                              |
|----------------|---------------|------------------------------------------|
| `-tunnel`      | false         | Open a bore.pub tunnel for a public URL  |
| `-note`        | —             | Description shown on the form            |
| `-out`         | `.env`        | Output .env file path                    |
| `-ttl`         | 30            | Minutes until the link expires           |
| `-port`        | random        | Local port to bind                       |
| `-listen-addr` | `127.0.0.1`   | Address to listen on                     |
| `-json`        | false         | Machine-readable JSON output             |

## Pi-native tool

On Pi, the `@pinchpass/cli` package registers a **`request_secret`** tool with
two collection modes (`via` param):

- **`modal`** (default in the interactive TUI): a Pi dialog collects each
  secret directly into the `.env` file. The value goes straight from the
  user's keyboard to disk — never to the LLM, never into the transcript, no
  server, no network. Cancelable with `Esc`.
- **`link`**: spawns the CLI, streams the one-time E2E-encrypted browser link
  to the user immediately, blocks until submit/TTL. Use when the user is not
  in the same Pi session (remote, tunneled, or RPC clients without a dialog
  handler).

`via` defaults to `auto`: modal in the TUI, link elsewhere. Prefer the tool on
Pi; use the CLI workflow below on other agents.

## Workflow

1. Run `pinchpass request <name>... -json` in the background.
2. Parse the first JSON blob from stdout — it contains the `url` field.
3. Present the URL to the user and tell them to open it in a browser.
4. Wait for the process to exit (it blocks until the user submits or TTL expires).
5. Parse the second JSON blob — `success: true` means the value was saved to `.env`.

### JSON output

Two JSON objects are printed to stdout, one before waiting and one after:

**Before waiting:**
```json
{"success": true, "names": ["SECRET_NAME"], "url": "http://...", "port": 12345, "message": "..."}
```

**After completion:**
```json
{"success": true, "names": ["SECRET_NAME"], "port": 12345, "message": "Secrets provisioned successfully."}
```

If `success` is false, the request timed out — no value was saved.

### Workflow example

```bash
# Collect an API key via public tunnel
pinchpass request API_KEY -tunnel -json
# → Prints link object with url field
# → Agent gives url to user
# → Agent waits for result
# → On completion, value in .env
```

## Important behavior

- **Blocking + exec timeouts**: `pinchpass` blocks until the user submits or
  TTL expires. If your agent's shell/exec tool has a command timeout (e.g.
  OpenClaw's `exec` tool defaults to 1800s), it **will kill pinchpass** when
  the timeout fires — and the bore tunnel dies with it, making the link return
  "Connection refused." You MUST disable or raise the exec timeout so it
  exceeds the TTL. Agent-specific guidance:
  - **OpenClaw**: pass `timeout: 0` in the exec tool call (disables the exec
    process timeout), and use `background: true` (or `yieldMs`) so you can
    present the URL from the first JSON blob while pinchpass waits. Poll the
    process or watch for the `.env` file to appear.
  - **Claude Code / opencode**: use `run_in_background` / background bash. The
    background session is not subject to the foreground command timeout.
  - **Other agents**: if the agent has no background/timeout-free mode, run
    pinchpass detached: `setsid nohup pinchpass request NAME -tunnel -json
    > /tmp/pinchpass.json 2>&1 &` then read `/tmp/pinchpass.json` for the URL.
    The process survives the agent's exec session. Check for the `.env` file
    or poll `ps` to detect completion.
- **One-time use**: after the first submission, the token is consumed. A second
  POST returns 404. If it fails, generate a new link.
- **TTL expiry**: the server shuts down after the TTL. Exit code is 1. Generate
  a new link with a longer `-ttl` if needed. Keep the TTL shorter than the exec
  timeout so pinchpass exits on its own before the agent can kill it.
- **Shell escaping**: values in `.env` are shell-escaped (`\`, `"`, `$`, `` ` ``).
  Existing keys are overwritten in place.
- **No tunnel**: without `-tunnel`, the link is only reachable on
  `127.0.0.1:<port>`. Use for local-only workflows or when the user is on the
  same machine.
- **bore.pub unreachable**: tunnel startup fails if bore.pub is down. Fall back
  to local mode or retry.
