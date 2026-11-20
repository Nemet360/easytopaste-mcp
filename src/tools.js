/**
 * The two tools this server exposes, and the rules they enforce.
 *
 * The product reason for this server, in one sentence: an agent that has to
 * hand a credential to a human has nowhere safe to put it today, so it pastes
 * it into the chat log — where it stays, searchable, for as long as the log
 * does. A one-time link does not fix that completely; it shrinks it to one
 * read and a known expiry.
 *
 * Which means the dangerous direction here is INWARD, not outward. A tool that
 * returned a secret's plaintext to an agent would put the thing back in the
 * transcript it was taken out of, so there is no read tool. `create_secret`
 * takes plaintext and returns a link; `get_secret_status` returns whether a
 * link is still live and nothing else.
 */

import {
  encryptTextToEnvelope, generateKey, toBase64Url, zeroize, MAX_INLINE_BYTES,
} from './vendor/crypto.js';
import { buildLink, DEFAULT_APP_BASE } from './vendor/link.js';

export const MAX_DAYS = 30;
export const MIN_DAYS = 1;

export const TOOLS = [
  {
    name: 'create_secret',
    description:
      'Encrypt a short text (a password, an API key, a note) and return a ' +
      'one-time link to it. The text is encrypted here; the key travels only ' +
      'inside the link and is never sent to the service, which stores ' +
      'ciphertext it cannot read. Use this instead of writing a credential ' +
      'into the conversation, a file or a ticket. The link is the secret: ' +
      'anyone holding it can read it once.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The value to share. UTF-8, up to 256 KB.',
        },
        days: {
          type: 'integer',
          minimum: MIN_DAYS,
          maximum: MAX_DAYS,
          default: 1,
          description: 'Whole days until the link expires on its own.',
        },
        one_time: {
          type: 'boolean',
          default: true,
          description:
            'true (default) destroys the secret the first time it is read.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_secret_status',
    description:
      'Report whether a one-time link is still live, by its locator. Returns ' +
      'status, expiry and size only — never the content, which this server ' +
      'cannot decrypt because it never had the key. Does not read or destroy ' +
      'the secret.',
    inputSchema: {
      type: 'object',
      properties: {
        locator: {
          type: 'string',
          description: 'The secret id, as returned by create_secret.',
        },
      },
      required: ['locator'],
      additionalProperties: false,
    },
  },
];

export class ToolError extends Error {
  constructor(message, code = 'invalid_input') {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

function normaliseDays(value) {
  if (value === undefined || value === null) return 1;
  if (!Number.isInteger(value)) {
    throw new ToolError(`days must be a whole number, got ${JSON.stringify(value)}`);
  }
  if (value < MIN_DAYS || value > MAX_DAYS) {
    throw new ToolError(`days must be between ${MIN_DAYS} and ${MAX_DAYS}, got ${value}`);
  }
  return value;
}

/**
 * Encrypt and create. Returns the link, the locator and the expiry.
 *
 * The key is zeroized after the link is built. It is a best-effort gesture in
 * a garbage-collected runtime and is done anyway, for the same reason the CLI
 * does it: the window in which a key sits in a long-lived agent process is
 * longer than the window in which it sits in a command that exits.
 */
export async function createSecret({ args, client, appBase = DEFAULT_APP_BASE }) {
  const text = args?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new ToolError('text is required and must be a non-empty string');
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_INLINE_BYTES) {
    throw new ToolError(
      `text is ${bytes} bytes; this server takes up to ${MAX_INLINE_BYTES}. ` +
      'A file that size belongs in the web app, which uploads it in chunks.',
      'too_large',
    );
  }
  const days = normaliseDays(args?.days);
  const oneTime = args?.one_time === undefined ? true : Boolean(args.one_time);

  const key = generateKey();
  try {
    const envelope = await encryptTextToEnvelope(text, key);
    const created = await client.createSecret({
      ciphertextB64: toBase64Url(envelope),
      sizeBytes: bytes,
      oneTime,
      expiresInDays: days,
    });
    const link = buildLink({ locator: created.locator, key, appBase });
    return {
      link,
      locator: created.locator,
      one_time: oneTime,
      expires_at: created.expiresAt ?? null,
      size_bytes: bytes,
    };
  } finally {
    zeroize(key);
  }
}

export async function getSecretStatus({ args, client }) {
  const locator = args?.locator;
  if (typeof locator !== 'string' || locator.trim() === '') {
    throw new ToolError('locator is required and must be a non-empty string');
  }
  return client.retrieveStatus(locator.trim());
}

/** What the agent is told, in words, after a successful create. */
export function describeCreate(result) {
  const life = result.one_time
    ? 'It dies the first time it is read'
    : 'It stays readable until it expires';
  const until = result.expires_at ? `, and expires at ${result.expires_at}` : '';
  return (
    `${result.link}\n\n${life}${until}. Give this link to the person who needs ` +
    'the value, through whatever channel you would have used anyway — the ' +
    'link is the secret, so treat it as one. The service cannot read the ' +
    'content: the key is in the part of the URL after the # and was never ' +
    `sent to it. Locator: ${result.locator}`
  );
}
