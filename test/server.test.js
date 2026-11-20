/**
 * The protocol surface and the two rules that matter more than the protocol:
 * no plaintext leaves this process, and no ciphertext comes back into the
 * agent's transcript.
 *
 * Nothing here touches the network. The API client is replaced with a fake, so
 * every assertion is about what WE build and send rather than about the
 * service being up.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOCOL_VERSION, SERVER_NAME, handle, toolFailureText,
} from '../src/server.js';
import { TOOLS, ToolError, createSecret, describeCreate } from '../src/tools.js';
import { ApiError, NetworkError, userAgent, channelTag } from '../src/api.js';
import { decryptEnvelopeToText, fromBase64Url } from '../src/vendor/crypto.js';
import { parseLink } from '../src/vendor/link.js';

function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async createSecret(body) {
      calls.push({ method: 'createSecret', body });
      return overrides.created ?? {
        locator: 'MFRGGZDFMZTWQ2LKNNWG23TP', expiresAt: '2026-11-21T00:00:00Z',
      };
    },
    async retrieveStatus(locator) {
      calls.push({ method: 'retrieveStatus', locator });
      return overrides.status ?? {
        locator, status: 'active', oneTime: true,
        expiresAt: '2026-11-21T00:00:00Z', sizeBytes: 12, createdAt: null,
      };
    },
  };
}

const ctx = (client) => ({ client, version: '9.9.9', appBase: 'https://app.easytopaste.com' });

test('initialize answers with the protocol version and names the server', async () => {
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ctx(fakeClient()));
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(res.result.serverInfo.name, SERVER_NAME);
  assert.equal(res.result.serverInfo.version, '9.9.9');
  assert.ok(res.result.capabilities.tools);
  assert.match(res.result.instructions, /one-time link/);
});

test('a notification is answered with nothing at all', async () => {
  const res = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx(fakeClient()));
  assert.equal(res, null, 'a notification has no id and must produce no line on stdout');
});

test('tools/list offers exactly two tools, and neither of them reads a secret', async () => {
  const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx(fakeClient()));
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['create_secret', 'get_secret_status']);
  // The absence is the design. A read tool would put the plaintext back into
  // the transcript the credential was being taken out of.
  for (const t of TOOLS) {
    assert.ok(!/\b(read|reveal|decrypt|fetch_secret)\b/i.test(t.name),
      `${t.name} reads like a tool that returns content`);
  }
});

test('an unknown method is a JSON-RPC error, an unknown tool is a tool error', async () => {
  const bad = await handle({ jsonrpc: '2.0', id: 3, method: 'nope' }, ctx(fakeClient()));
  assert.equal(bad.error.code, -32601);

  const unknown = await handle(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_everything' } },
    ctx(fakeClient()),
  );
  assert.equal(unknown.error.code, -32602);
});

test('create_secret sends ciphertext and nothing else', async () => {
  const client = fakeClient();
  await handle(
    {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'create_secret', arguments: { text: 'hunter2', days: 3, one_time: false } },
    },
    ctx(client),
  );
  const { body } = client.calls[0];
  assert.deepEqual(Object.keys(body).sort(), [
    'ciphertextB64', 'expiresInDays', 'oneTime', 'sizeBytes',
  ]);
  assert.equal(body.expiresInDays, 3);
  assert.equal(body.oneTime, false);
  assert.equal(body.sizeBytes, 7);
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes('hunter2'), 'the plaintext reached the request body');
});

test('the key is in the link and never in the request', async () => {
  const client = fakeClient();
  const res = await handle(
    {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'create_secret', arguments: { text: 'correct horse' } },
    },
    ctx(client),
  );
  const link = res.result.structuredContent.link;
  const { locator, key } = parseLink(link);
  assert.equal(locator, 'MFRGGZDFMZTWQ2LKNNWG23TP');

  // The round trip: what the service stores decrypts with the key from the
  // fragment, and that key appears nowhere in what we sent.
  const envelope = fromBase64Url(client.calls[0].body.ciphertextB64, 'ciphertext');
  assert.equal(await decryptEnvelopeToText(envelope, key), 'correct horse');
  assert.ok(!JSON.stringify(client.calls[0].body).includes(link.split('#')[1]));
});

test('get_secret_status never returns content', async () => {
  const client = fakeClient({
    // The real endpoint hands back the envelope alongside the metadata.
    status: { locator: 'L', status: 'active', oneTime: true, expiresAt: null,
      sizeBytes: 3, createdAt: null },
  });
  const res = await handle(
    {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'get_secret_status', arguments: { locator: 'L' } },
    },
    ctx(client),
  );
  const keys = Object.keys(res.result.structuredContent).sort();
  assert.deepEqual(keys, ['createdAt', 'expiresAt', 'locator', 'oneTime', 'sizeBytes', 'status']);
  for (const forbidden of ['ciphertext', 'envelope', 'content', 'plaintext', 'key']) {
    assert.ok(!keys.includes(forbidden), `status leaked ${forbidden}`);
  }
});

test('a bad argument comes back as a tool failure, not a dead call', async () => {
  const res = await handle(
    {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'create_secret', arguments: { text: 'x', days: 99 } },
    },
    ctx(fakeClient()),
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /days must be between 1 and 30/);
  assert.ok(!res.error, 'the agent must be able to read the failure and retry');
});

test('empty text is refused before anything is sent', async () => {
  const client = fakeClient();
  const res = await handle(
    {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'create_secret', arguments: { text: '' } },
    },
    ctx(client),
  );
  assert.equal(res.result.isError, true);
  assert.equal(client.calls.length, 0);
});

test('the quota wall is explained rather than echoed', () => {
  const text = toolFailureText(new ApiError('Daily cap hit.', { code: 'quota_exceeded' }));
  assert.match(text, /per outgoing IP address/);
  assert.match(text, /midnight UTC/);
  assert.match(toolFailureText(new NetworkError('down', null)), /^network:/);
  assert.match(toolFailureText(new ToolError('nope')), /^invalid_input:/);
});

test('the User-Agent names the server and can carry its install channel', () => {
  assert.equal(userAgent('1.0.0', {}), 'easytopaste-mcp/1.0.0');
  assert.equal(userAgent('1.0.0', { EASYTOPASTE_CHANNEL: 'Smithery' }),
    'easytopaste-mcp/1.0.0 (smithery)');
  assert.equal(channelTag({ EASYTOPASTE_CHANNEL: 'a\r\nb' }), 'ab');
});

test('the text handed to the agent explains what the link is', async () => {
  const result = await createSecret({
    args: { text: 'hi' }, client: fakeClient(), appBase: 'https://app.easytopaste.com',
  });
  const text = describeCreate(result);
  assert.match(text, /dies the first time it is read/);
  assert.match(text, /the link is the secret/);
  assert.ok(!text.includes('hi\n'), 'the description must not echo the plaintext');
});
