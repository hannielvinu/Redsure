// Reads a forwarded blood-request text and pulls out the facts.
// Uses an LLM (Groq, OpenAI-compatible) when GROQ_API_KEY is set; always runs the
// rule-based reader too, so the feature works without a key and the AI never
// invents fields the text does not contain.

import { MONEY_RE } from './shared.js';
const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

export function normaliseGroup(s) {
  if (!s) return null;
  const t = String(s)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/POSITIVE|POS|VE\+|\+VE|\(\+\)/g, '+')
    .replace(/NEGATIVE|NEG|VE-|-VE|\(-\)/g, '-')
    .replace(/[–—]/g, '-');
  const m = t.match(/^(AB|A|B|O)([+-])/);
  return m ? m[1] + m[2] : null;
}

export function ruleRead(text) {
  const t = text.replace(/\s+/g, ' ');
  const out = { bloodGroup: null, units: null, hospital: null, city: null, phone: null, date: null, patient: null };
  const g = t.match(/\b(AB|A|B|O)\s*(\+|-|–|positive|negative|pos|neg|\+ve|-ve|ve\+|ve-)/i);
  if (g) out.bloodGroup = normaliseGroup(g[1] + g[2]);
  const u = t.match(/(\d{1,2})\s*(units?|bottles?|bags?|donors?|pints?)/i);
  if (u) out.units = Number(u[1]);
  const h = t.match(/(?:at|@|in)\s+([A-Z][\w.&' -]{2,60}?(?:hospital|medical|clinic|institute|nursing home|blood bank|AIIMS|CMC|PGI)[\w .'-]{0,30}?)(?=[,.\n]|$| for| on| contact| call| ph)/i)
    || t.match(/([A-Z][\w.&' -]{2,40}\s(?:Hospital|Hospitals|Medical College|Clinic|Institute))/);
  if (h) out.hospital = h[1].trim();
  const p = t.match(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/);
  if (p) out.phone = p[0].replace(/\D/g, '').slice(-10);
  const d = t.match(/\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{4})?|today|tonight|tomorrow)\b/i);
  if (d) out.date = d[1];
  return out;
}

async function llmRead(text) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const body = {
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You read forwarded blood-donation request messages. Return JSON with keys: ' +
          'bloodGroup (one of A+,A-,B+,B-,AB+,AB-,O+,O- or null), units (number or null), hospital (string or null), ' +
          'city (string or null), phone (digits or null), date (the date or day written in the text, or null), patient (string or null), ' +
          'redFlags (array of short strings: e.g. "no date", "asks for money or a fee", "no hospital named", "plasma/covid wording", "says forward to all groups"). ' +
          'Copy only what the text says. Never guess a value that is not written. Never judge whether it is fake.',
      },
      { role: 'user', content: text.slice(0, 4000) },
    ],
  };
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return JSON.parse(j.choices?.[0]?.message?.content || 'null');
  } catch {
    return null;
  }
}

export function ruleFlags(text, f) {
  const flags = [];
  if (!f.date) flags.push('no date in the message');
  if (!f.hospital) flags.push('no hospital named');
  if (MONEY_RE.test(text)) flags.push('mentions money, a fee or a payment');
  if (/forward|share (?:to|in) all|maximum share|pls share/i.test(text)) flags.push('asks you to forward it to every group');
  if (/plasma|covid/i.test(text)) flags.push('plasma/COVID wording (common in recycled 2020-21 lists)');
  return flags;
}

export async function readForward(text) {
  const rule = ruleRead(text);
  const ai = await llmRead(text);
  const merged = { ...rule };
  if (ai) {
    for (const k of Object.keys(merged)) {
      const v = ai[k];
      // Accept an AI value only if it is actually present in the text (no invented fields).
      if (v === null || v === undefined || v === '') continue;
      if (k === 'bloodGroup') {
        const g = normaliseGroup(v);
        if (g) merged.bloodGroup = g;
      } else if (k === 'units') {
        if (Number.isFinite(Number(v))) merged.units = Number(v);
      } else if (k === 'phone') {
        const digits = String(v).replace(/\D/g, '').slice(-10);
        if (digits && text.replace(/\D/g, '').includes(digits)) merged.phone = digits;
      } else if (text.toLowerCase().includes(String(v).toLowerCase().slice(0, 12))) {
        merged[k] = String(v);
      }
    }
  }
  const flags = new Set(ruleFlags(text, merged));
  // Keep AI flags only when the rules did not already cover the same point.
  const covered = /date|money|fee|pay|forward|share|hospital|plasma|covid/i;
  if (ai && Array.isArray(ai.redFlags)) ai.redFlags.slice(0, 5).forEach((x) => { if (!covered.test(x)) flags.add(String(x)); });
  return { fields: merged, flags: [...flags], reader: ai ? 'ai+rules' : 'rules' };
}

export { GROUPS };
