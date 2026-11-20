/**
 * MCP over stdio, JSON-RPC 2.0, with no dependencies.
 *
 * Why no SDK: the same reason the GitHub Action ships its dependencies as
 * committed JavaScript. The protocol this wraps is four methods and a
 * line-delimited JSON framing, the audience installs it with `npx` into an
 * agent that is already holding their credentials, and every dependency is
 * something that audience has to trust on our word. The whole server is
 * readable in one sitting, which is the point.
 *
 * Framing: one JSON object per line on stdin, one per line on stdout.
 * **Nothing else may ever be written to stdout** — a stray `console.log` is
 * not a cosmetic bug here, it is a protocol error that breaks the client's
 * parse. Diagnostics go to stderr, which the host shows in its logs.
 */

import { createInterface } from 'node:readline';

import { ApiClient, ApiError, NetworkError } from './api.js';
import {
  TOOLS, ToolError, createSecret, getSecretStatus, describeCreate,
} from './tools.js';
import { DEFAULT_API_BASE, DEFAULT_APP_BASE } from './vendor/link.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'easytopaste';

/** Build the response for one request object. Returns null for a notification. */
export async function handle(message, ctx) {
  const { id, method, params } = message ?? {};
  const isNotification = id === undefined || id === null;

  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, msg, data) =>
    (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: msg, ...(data ? { data } : {}) } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: ctx.version },
        instructions:
          'Use create_secret whenever you are about to put a password, an API ' +
          'key or any other credential into the conversation, a file or a ' +
          'ticket. It returns a one-time link you can paste instead. There is ' +
          'no tool that reads a secret back: that would put the value into the ' +
          'transcript, which is what this exists to avoid.',
      });

    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({ tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        if (name === 'create_secret') {
          const result = await createSecret({ args, client: ctx.client, appBase: ctx.appBase });
          return reply({
            content: [{ type: 'text', text: describeCreate(result) }],
            structuredContent: result,
          });
        }
        if (name === 'get_secret_status') {
          const result = await getSecretStatus({ args, client: ctx.client });
          return reply({
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          });
        }
        return fail(-32602, `unknown tool: ${String(name)}`);
      } catch (err) {
        // A tool failure is reported INSIDE the result, not as a JSON-RPC
        // error: the agent is supposed to read it, decide, and try something
        // else. A protocol-level error would just end the call.
        return reply({
          content: [{ type: 'text', text: toolFailureText(err) }],
          isError: true,
        });
      }
    }

    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
}

export function toolFailureText(err) {
  if (err instanceof ToolError) return `${err.code}: ${err.message}`;
  if (err instanceof ApiError) {
    if (err.code === 'quota_exceeded') {
      return (
        'quota_exceeded: this host has used its daily allowance of anonymous ' +
        'secrets. The allowance is counted per outgoing IP address, which ' +
        'several machines can share. It resets at midnight UTC.'
      );
    }
    if (err.code === 'rate_limited') {
      return `rate_limited: too many requests. Retry after ${err.retryAfter ?? 'a minute'}.`;
    }
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof NetworkError) return `network: ${err.message}`;
  return `unexpected: ${err?.message ?? String(err)}`;
}

/** Read line-delimited JSON from stdin and answer on stdout. */
export function serve({
  input = process.stdin,
  output = process.stdout,
  errorOut = process.stderr,
  version = '0.0.0',
  env = process.env,
} = {}) {
  const client = new ApiClient({
    baseUrl: env.EASYTOPASTE_API_BASE || DEFAULT_API_BASE,
    token: env.EASYTOPASTE_TOKEN || '',
    version,
    env,
  });
  const ctx = { client, version, appBase: env.EASYTOPASTE_APP_BASE || DEFAULT_APP_BASE };

  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`);

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    // Each line is answered on its own; a slow create must not block a ping.
    handle(message, ctx)
      .then((response) => {
        if (response) write(response);
      })
      .catch((err) => {
        errorOut.write(`easytopaste-mcp: ${err?.stack ?? err}\n`);
        if (message?.id !== undefined && message?.id !== null) {
          write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: 'internal error' },
          });
        }
      });
  });

  return rl;
}
