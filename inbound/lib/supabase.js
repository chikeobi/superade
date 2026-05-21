/**
 * lib/supabase.js — Shared Supabase client for inbound system
 *
 * Mirrors engine/lib/supabase.js — same env vars, separate instance.
 * Node 20 requires the ws polyfill for Supabase realtime.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: WebSocket } }
);
