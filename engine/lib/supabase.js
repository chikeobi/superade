/**
 * lib/supabase.js — Shared Supabase client
 *
 * Centralizes client creation so the ws polyfill and env var name
 * are configured in exactly one place.
 *
 * Node.js 20 does not expose a global WebSocket — we must pass the
 * ws package explicitly so the Supabase realtime layer can connect.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: WebSocket } }
);
