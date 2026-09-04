// SpaWaterFix worker — static assets + POST /api/ask AI proxy.
// Architecture: LLM parses -> chemistry.js computes -> LLM explains. Doses are never model-generated.
import { analyzeWater, SYSTEMS } from './chemistry.js';

const DAILY_LIMIT = 20;          // free questions per IP per day
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS_PARSE = 300;
const MAX_TOKENS_ANSWER = 500;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      try { return await handleAsk(req, env); }
      catch (err) {
        console.error('api/ask failed:', err);
        return json({ error: 'The assistant is unavailable right now — try the test-strip form below.' }, 502);
      }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(req);
  }
};

async function handleAsk(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const message = String(body.message || '').slice(0, 1000);
  const savedProfile = body.profile || null; // {gallons, system} from the client, if user set one
  if (!message.trim()) return json({ error: 'Empty message' }, 400);

  // ── rate limit (per IP per UTC day)
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const used = parseInt((await env.RATE_KV.get(key)) || '0', 10);
  if (used >= DAILY_LIMIT) {
    return json({ error: 'Daily free limit reached. Try again tomorrow, or use the test-strip form — it never runs out.' }, 429);
  }
  await env.RATE_KV.put(key, String(used + 1), { expirationTtl: 90000 });

  // ── call 1: parse the message into structured data
  const parsePrompt = `Extract hot tub water data from the user's message. Respond with ONLY minified JSON, no prose:
{"gallons":number|null,"system":"chlorine"|"bromine"|"frog-bromine"|"chlorine-mineral"|null,"readings":{"ph":number|null,"ta":number|null,"ch":number|null,"fc":number|null,"br":number|null,"phos":number|null,"tds":number|null},"problem":"short description of the symptom in their words"|null}
Rules: numbers only when stated or clearly implied ("pH around 8" -> 8.0). "chlorine smell", vague words are problem text, not readings. Mentions of FROG/mineral cartridge -> frog-bromine or chlorine-mineral. Do not guess gallons.`;
  const parsed = await claude(env, parsePrompt, message, MAX_TOKENS_PARSE);
  let data;
  try { data = JSON.parse(parsed.replace(/```json|```/g, '').trim()); } catch { data = { readings: {} }; }

  // ── deterministic engine (when we have enough to compute)
  const profile = {
    gallons: data.gallons || savedProfile?.gallons || null,
    system: data.system || savedProfile?.system || null
  };
  let engine = null, assumed = [];
  const hasReadings = Object.values(data.readings || {}).some(v => v !== null && v !== undefined);
  if (hasReadings) {
    if (!profile.gallons) { profile.gallons = 400; assumed.push('a typical 400-gallon spa'); }
    if (!profile.system) { profile.system = data.readings.br != null ? 'bromine' : 'chlorine'; assumed.push(`a ${profile.system} system`); }
    engine = analyzeWater(profile, data.readings);
    if (engine.error) engine = null;
  }

  // ── call 2: compose the answer around the engine result
  const answerPrompt = `You are SpaWaterFix, a concise hot tub water chemistry assistant on spawaterfix.com.
${engine ? `ENGINE RESULT (authoritative — repeat these doses EXACTLY, never change or invent dose amounts):\n${JSON.stringify(engine)}` : 'No computed result — not enough numeric readings. Answer from general spa chemistry knowledge; if dosing would help, ask for their test readings and tub volume.'}
${assumed.length ? `Assumptions made: ${assumed.join(', ')} — state them briefly and invite correction.` : ''}
Style: plain, friendly, short paragraphs. If steps exist, present them in order with the exact dose strings. Never diagnose health issues; for rashes/illness advise a doctor. If the message is not about hot tubs/spas, say you only do hot tub water chemistry, in one sentence.`;
  const answer = await claude(env, answerPrompt, message, MAX_TOKENS_ANSWER);

  return json({
    answer,
    engine,                     // client renders steps/gauges (with affiliate links) from this
    remaining: DAILY_LIMIT - used - 1
  });
}

async function claude(env, system, userMessage, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' }
});
