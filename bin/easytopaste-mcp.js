#!/usr/bin/env node
/**
 * Entry point. Keep this file boring: the protocol forbids anything on stdout
 * that is not a JSON-RPC message, so there is no banner, no version line and
 * no "listening" notice here. Diagnostics go to stderr.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { serve } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

serve({ version: pkg.version });
