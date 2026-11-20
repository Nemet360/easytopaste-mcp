# EasyToPaste MCP server

Hand a credential to a human **without putting it in the chat log**.

> **Not on npm yet.** `npx -y easytopaste-mcp` resolves the day the package is
> published; publishing is the owner's call and is pending. Until then, install
> from source — clone this repository and point the `command` at
> `node /path/to/easytopaste-mcp/bin/easytopaste-mcp.js`. Everything below is
> true of both.

```jsonc
// Claude Desktop: claude_desktop_config.json
{
  "mcpServers": {
    "easytopaste": {
      "command": "npx",
      "args": ["-y", "easytopaste-mcp"]
    }
  }
}
```

Then, in the conversation:

> **agent:** The deploy key is `AKIA…` — I'll send it as a one-time link instead.
> *(calls `create_secret`)*
> `https://app.easytopaste.com/s/MFRG…#k=…`

## Why this exists

An agent that has to pass a password, an API key or a token to a person has
nowhere safe to put it today, so it pastes it into the conversation — where it
stays, searchable, for as long as the transcript does, in whatever tool the
transcript syncs to. A one-time link does not fix that completely. It shrinks
it to one read and a known expiry, and it moves the value out of the log.

## The two tools, and the one that is deliberately missing

| tool | what it does |
| --- | --- |
| `create_secret` | encrypts a text here and returns a one-time link |
| `get_secret_status` | says whether a link is still live — status, expiry, size |

There is **no tool that reads a secret back**. That is the design, not an
omission: a read tool would put the plaintext into the transcript the
credential was being taken out of. `get_secret_status` never returns content,
and the server could not decrypt it if it tried — it does not have the key.

## What leaves this process

The text is encrypted here with AES-256-GCM and a fresh 32-byte key. **Only
ciphertext is sent.** The key goes into the link's URL fragment — the part
after the `#`, which no HTTP client transmits — so the service stores a blob
it cannot read.

The request carries the ciphertext, its size, the expiry and the one-time
flag, and nothing else: no plaintext, no key, no conversation, no model name,
no telemetry. `test/server.test.js` asserts the request body field by field,
including that the plaintext does not appear in it.

Being precise about the rest, because a request is never only its body: the
service sees what any server sees — your machine's outgoing IP address, which
is what the daily anonymous allowance is counted against — and a `User-Agent`
of `easytopaste-mcp/<version>`.

## The limit you will meet first

There is no long-lived API key for machines yet. Anonymous callers share a
daily allowance of **10 creates per outgoing IP address**, and an office, a VPN
or a hosted agent platform can be one address for everybody on it. When it is
gone, `create_secret` answers `quota_exceeded` and says so in words rather than
failing silently. Set `EASYTOPASTE_TOKEN` if you have a bearer token from an
earlier step; access tokens last 15 minutes, which is why there is no way to
configure a permanent one.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `EASYTOPASTE_TOKEN` | *(empty)* | optional bearer access token |
| `EASYTOPASTE_API_BASE` | `https://api.easytopaste.com` | override for self-hosting |
| `EASYTOPASTE_APP_BASE` | `https://app.easytopaste.com` | origin used to build links |
| `EASYTOPASTE_CHANNEL` | *(empty)* | where this copy was installed from, reported in the User-Agent |

## No dependencies

The protocol is JSON-RPC 2.0 over line-delimited stdio, and the whole server
is readable in one sitting. This installs into an agent that is already
holding your credentials; every dependency would be one more thing you have to
trust on our word.

What it is: <https://easytopaste.com/?utm_source=mcp&utm_medium=server&utm_campaign=launch-2026-11>
· how the encryption works: <https://easytopaste.com/how-it-works/?utm_source=mcp&utm_medium=server&utm_campaign=launch-2026-11>
· the same thing from a terminal: `npm i -g easytopaste`
