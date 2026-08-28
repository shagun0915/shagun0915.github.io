// api/chat.js — Vercel Edge Function.
// Proxies the portfolio chat to Google Gemini so the API key never reaches the
// browser. Streams the reply back as plain-text chunks.
//
// Required env var (set in Vercel → Project → Settings → Environment Variables):
//   GEMINI_API_KEY   — from https://aistudio.google.com/apikey  (free tier)
// Optional env var:
//   ALLOWED_ORIGINS  — comma-separated list of sites allowed to call this.
//                      Defaults to Shagun's site + localhost. Example:
//                      "https://shagun0915.github.io,https://shagunyadav.com"

import { SYSTEM_PROMPT } from './_persona.js';

export const config = { runtime: 'edge' };

// Edge Functions are killed at 25s. Abort the Gemini call a little before that
// so the visitor gets a clean "try again" JSON error (which the widget retries
// once automatically) instead of a raw 504 error page. Gemini's free tier
// normally answers in 3–7s; this only bites on a cold/slow first token.
const UPSTREAM_TIMEOUT_MS = 20000;

const MODEL = 'gemini-3.6-flash';
const MAX_MESSAGES = 16;        // total turns kept from the client
const MAX_CHARS_PER_MSG = 1500; // per message
const MAX_CHARS_TOTAL = 8000;   // whole conversation

const DEFAULT_ORIGINS = [
  'https://shagun0915.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function allowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ORIGINS;
}

function corsHeaders(origin) {
  const list = allowedOrigins();
  const ok = origin && (list.includes(origin) || origin.endsWith('.vercel.app'));
  return {
    'Access-Control-Allow-Origin': ok ? origin : list[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, origin);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: 'Assistant is not configured yet.' }, 500, origin);
  }

  // ---- parse + validate -----------------------------------------------------
  let messages;
  try {
    const data = await req.json();
    messages = data && data.messages;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400, origin);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages must be a non-empty array.' }, 400, origin);
  }

  messages = messages.slice(-MAX_MESSAGES).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' && m.content.trim(),
  );
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'Last message must be from the user.' }, 400, origin);
  }

  let total = 0;
  for (const m of messages) {
    m.content = m.content.slice(0, MAX_CHARS_PER_MSG);
    total += m.content.length;
  }
  if (total > MAX_CHARS_TOTAL) {
    return json({ error: 'Conversation is too long — start a new chat.' }, 413, origin);
  }

  // ---- build Gemini request ----------------------------------------------
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const upstreamUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 800,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(abortTimer);
    const timedOut = err && err.name === 'AbortError';
    return json(
      { error: timedOut
          ? 'The assistant took too long to respond — please try again.'
          : 'Could not reach the model.' },
      timedOut ? 504 : 502,
      origin,
    );
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(abortTimer);
    let detail = '';
    try { detail = await upstream.text(); } catch {}
    console.error('GEMINI_ERROR', upstream.status, detail.slice(0, 800));
    // 429 = Gemini free-tier rate limit. Google includes a retry hint; a short
    // one (seconds) means a per-minute burst limit, a long one means the daily
    // cap is spent.
    const retryHint = parseFloat(
      (detail.match(/retry in ([\d.]+)s/i) || detail.match(/"retryDelay":\s*"([\d.]+)s/i) || [])[1],
    );
    const perDay = /PerDay|per day|daily/i.test(detail) || (retryHint && retryHint > 300);
    const friendly =
      upstream.status === 429
        ? perDay
          ? "The assistant has hit today's usage limit. Please try again tomorrow, or email shagun0915@gmail.com."
          : "The assistant is handling a lot of questions right now — please try again in a minute."
        : 'The assistant ran into a problem. Please try again in a moment.';
    return json({ error: friendly }, upstream.status === 429 ? 429 : 502, origin);
  }

  // ---- transform Gemini SSE -> plain text stream --------------------------
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let sawText = false;
      let blockedReason = '';

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let obj;
        try { obj = JSON.parse(payload); } catch { return; }
        const cand = obj?.candidates?.[0];
        const parts = cand?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p.text) { controller.enqueue(encoder.encode(p.text)); sawText = true; }
          }
        }
        // SAFETY / RECITATION / OTHER with no content
        if (cand?.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS') {
          blockedReason = cand.finishReason;
        }
        if (obj?.promptFeedback?.blockReason) blockedReason = obj.promptFeedback.blockReason;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) handleLine(line);
        }
        // flush any trailing line the stream didn't newline-terminate
        buffer += decoder.decode();
        if (buffer.trim()) handleLine(buffer);

        if (!sawText) {
          console.error('GEMINI_EMPTY', blockedReason || 'no-text');
          controller.enqueue(encoder.encode(
            blockedReason
              ? "I can't answer that one. Ask me something about Shagun's work or background."
              : "Sorry — I didn't get a response that time. Please try again.",
          ));
        }
      } catch {
        if (!sawText) {
          controller.enqueue(encoder.encode('Sorry — the response was interrupted. Please try again.'));
        }
      } finally {
        clearTimeout(abortTimer);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}
