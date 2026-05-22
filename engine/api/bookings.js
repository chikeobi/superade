/**
 * api/bookings.js — Public booking API
 *
 * GET  /api/slots?date=YYYY-MM-DD  → available time slots for a date
 * GET  /api/availability           → which days of week have any slots (for calendar UI)
 * POST /api/bookings               → create a booking
 *
 * CORS-enabled for suparade.com only.
 */

import express from 'express';
import { supabase } from '../lib/supabase.js';

export const bookingsRouter = express.Router();

// ─── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED = ['https://suparade.com', 'https://www.suparade.com'];

bookingsRouter.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── GET /api/availability — days of week that have enabled slots ──────────────

bookingsRouter.get('/availability', async (_req, res) => {
  const { data } = await supabase
    .from('availability')
    .select('day_of_week')
    .eq('enabled', true);

  const days = [...new Set((data || []).map(r => r.day_of_week))];
  res.json({ days });
});

// ─── GET /api/slots?date=YYYY-MM-DD ──────────────────────────────────────────

bookingsRouter.get('/slots', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  // Reject past dates
  if (date < new Date().toISOString().slice(0, 10)) {
    return res.json({ slots: [] });
  }

  // noon UTC avoids any DST ambiguity when getting the weekday
  const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();

  const { data: slots } = await supabase
    .from('availability')
    .select('time_slot')
    .eq('day_of_week', dayOfWeek)
    .eq('enabled', true)
    .order('time_slot');

  if (!slots?.length) return res.json({ slots: [] });

  const { data: booked } = await supabase
    .from('bookings')
    .select('time_slot')
    .eq('date', date)
    .neq('status', 'cancelled');

  const taken = new Set((booked || []).map(b => b.time_slot));
  const available = slots.filter(s => !taken.has(s.time_slot)).map(s => s.time_slot);

  res.json({ slots: available });
});

// ─── POST /api/bookings ───────────────────────────────────────────────────────

bookingsRouter.post('/', express.json({ limit: '10kb' }), async (req, res) => {
  const { name, email, phone, business_type, date, time_slot } = req.body || {};

  if (!name || !email || !date || !time_slot) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date.' });
  }

  // Confirm slot is still in availability
  const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();
  const { data: slotRow } = await supabase
    .from('availability')
    .select('id')
    .eq('day_of_week', dayOfWeek)
    .eq('time_slot', time_slot)
    .eq('enabled', true)
    .maybeSingle();

  if (!slotRow) return res.status(409).json({ error: 'That slot is no longer available.' });

  // Check for conflicts
  const { data: conflict } = await supabase
    .from('bookings')
    .select('id')
    .eq('date', date)
    .eq('time_slot', time_slot)
    .neq('status', 'cancelled')
    .maybeSingle();

  if (conflict) return res.status(409).json({ error: 'That slot was just taken. Please choose another.' });

  const { error } = await supabase.from('bookings').insert({
    name:          name.trim(),
    email:         email.trim().toLowerCase(),
    phone:         phone?.trim() || null,
    business_type: business_type?.trim() || null,
    date,
    time_slot,
  });

  if (error) {
    console.error('[bookings] Insert error:', error.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  console.log(`[bookings] New booking: ${email} on ${date} at ${time_slot}`);
  res.json({ ok: true });
});
