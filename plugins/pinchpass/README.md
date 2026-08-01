# @pinchpass/cli

One-time **E2E-encrypted** secret request links for AI agents.

Generate a temporary HTTP server with a single-use encrypted form for
collecting sensitive values (API keys, tokens, passwords) — locally or over
the internet via a built-in bore.pub tunnel. **The relay never sees the
secret**: encryption happens in the browser, and the decryption key lives only
in the URL fragment.

## Install

```sh
npm i -g @pinchpass/cli
```

The install downloads the prebuilt `pinchpass` binary for your platform to
`~/.local/bin` (or finds an existing install).

## Pi (pi.dev)

This package is a native [Pi](https://pi.dev) package:

```sh
pi install npm:@pinchpass/cli
```

That registers:

- **`request_secret` tool** — spawns the CLI, streams the one-time link to the
  user immediately, blocks until they submit or the TTL expires, then returns
  the result (saved to `.env`). Cancelable with `Esc`.
- **`pinchpass` skill** — full usage guidance for the model.

The binary is resolved from `PATH`, `~/.local/bin`, `~/.openclaw/bin`, and
`~/.pi/bin` — no PATH configuration required.

## OpenClaw

Installed as a plugin, it registers the same `request_secret` tool. Note that
the OpenClaw path executes the CLI in the foreground: keep the exec timeout
longer than the TTL, or the link dies with the exec session.

## CLI

```sh
pinchpass request <secret-name>... [flags]
```

| Flag       | Default   | Description                             |
|------------|-----------|-----------------------------------------|
| `-tunnel`  | false     | Open a bore.pub tunnel for a public URL |
| `-note`    | —         | Description shown on the form           |
| `-out`     | `.env`    | Output .env file path                   |
| `-ttl`     | 30        | Minutes until the link expires          |
| `-port`    | random    | Local port to bind                      |
| `-json`    | false     | Machine-readable JSON output            |

## License

MIT
