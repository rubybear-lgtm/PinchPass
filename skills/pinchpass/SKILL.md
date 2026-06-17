---
name: pinchpass
description: Collect sensitive values (API keys, tokens, passwords, credentials) from the user via a one-time E2E-encrypted link. Use when you need a secret the user hasn't provided, when populating a .env file with credentials, or when the user says they need to give you a key/token/password.
---

Securely collect sensitive values from users with end-to-end encryption. The
relay server never sees the plaintext — encryption happens in the browser, and
the decryption key lives only in the URL fragment (never sent to the server).

## Prerequisites

Check that `pinchpass` is available:

```bash
which pinchpass
```

If missing, install it:

```bash
go install github.com/rubybear-lgtm/pinchpass@latest
```

If Go is not available, download the binary from
https://github.com/rubybear-lgtm/PinchPass/releases — pick the right
platform/arch and place it on `$PATH`.

## Usage

Always use `-json` mode so you can parse the output programmatically.

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

## Important behavior

- **Blocking**: `pinchpass` blocks until the user submits or TTL expires. Run it
  with `run_in_background` or in a subshell so you can present the URL while
  waiting.
- **One-time use**: after the first submission, the token is consumed. A second
  POST returns 404. If it fails, generate a new link.
- **TTL expiry**: the server shuts down after the TTL. Exit code is 1.
- **Shell escaping**: values in `.env` are shell-escaped (`\`, `"`, `$`, `` ` ``).
  Existing keys are overwritten in place.
- **bore.pub**: without `-tunnel`, the link is only reachable on localhost. Use
  `-tunnel` for remote users. If bore.pub is unreachable, fall back to local mode.

## When NOT to use

Do not use pinchpass for non-sensitive plaintext values. If the value is not a
secret, just ask the user to paste it directly.
