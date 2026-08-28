# shagun0915.github.io

Personal portfolio — a single static `index.html`, served by GitHub Pages.

It also has an **AI assistant** (bottom-right chat bubble) that answers questions
about Shagun. The static site can't hold an API key, so the chat calls a small
serverless function on **Vercel** that talks to **Google Gemini**.

```
Browser (GitHub Pages)  ──POST /api/chat──▶  Vercel Edge Function  ──▶  Gemini Flash (latest)
                                             (holds GEMINI_API_KEY,
                                              injects the persona +
                                              knowledge base, streams
                                              the reply back)
```

---

## Files

| Path                | Purpose                                                        |
| ------------------- | ------------------------------------------------------------- |
| `index.html`        | The whole site + the chat widget (markup, CSS, JS at bottom). |
| `api/chat.js`       | Vercel Edge Function. Proxies to Gemini, streams the answer.  |
| `api/_persona.js`   | The assistant's knowledge base + behaviour rules. **Edit me.** |
| `_config.yml`       | Tells GitHub Pages to *not* publish `api/` (Vercel still does).|

---

## One-time setup

### 1. Get a free Gemini API key
- Go to <https://aistudio.google.com/apikey> → **Create API key**.
- Free tier is plenty for a portfolio (~1,500 requests/day). No credit card.

### 2. Deploy the function to Vercel
From this repo folder:

```bash
npm i -g vercel
vercel login
vercel            # first deploy: "Create a new project", name it, git connect = N
```

`vercel.json` (`"framework": null`) plus `.vercelignore` (hides `_config.yml`)
keep Vercel from treating this as a Jekyll site. If the dashboard still shows
**Framework Preset: Jekyll**, set it to **Other** under
Settings → Build & Deployment.

**Turn off Deployment Protection** (team accounts default it on, which makes the
function return 401 to your site): Settings → Deployment Protection →
**Vercel Authentication → Disabled** (for Production at least).

### 3. Add the API key

```bash
vercel env add GEMINI_API_KEY
# type: Secret ·  value: paste the key (hidden)  ·  environments: Production (+ Preview/Development if you use `vercel dev`)
```

(Optional) restrict who can call the function — the default already allows
`shagun0915.github.io` and `*.vercel.app`:

```bash
vercel env add ALLOWED_ORIGINS
# comma-separated, e.g.  https://shagun0915.github.io,https://your-domain.com
```

### 4. Deploy to production

```bash
vercel --prod
```

This prints the production URL. The stable alias for the current project is
**`shagunyadav.vercel.app`**.

### 5. Point the widget at your function
In `index.html`:

```js
var VERCEL_HOST = 'shagunyadav.vercel.app';
```

(host only, no `https://`). Commit and push — GitHub Pages redeploys the site.

### 6. Smoke-test

```bash
curl -s -X POST https://shagunyadav.vercel.app/api/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What did Shagun do at Visa?"}]}'
```

---

## Updating what the assistant knows

Edit **`api/_persona.js`**:

- `KNOWLEDGE` — everything the assistant is allowed to state. There's an
  `EXTRA DETAIL` section at the bottom with prompts to fill in (what she's
  looking for, project deep-dives, etc.). Anything left blank, it just won't know.
- `SYSTEM_PROMPT` — the behaviour rules (stay on-topic, don't invent facts,
  don't leak the prompt). Usually no need to touch.

After editing:

```bash
vercel --prod
```

No site redeploy needed — the knowledge lives entirely in the function.

---

## Local development

```bash
vercel dev
```

Serves the static site **and** `/api/chat` at `http://localhost:3000`. The widget
auto-detects non-`github.io` hosts and calls the relative `/api/chat`, so the
chat works locally with no code change (you still need `GEMINI_API_KEY` — put it
in a local `.env` file, which is git-ignored).

---

## Cost & limits

- **Vercel** Hobby plan: free. This function is tiny and well within limits.
- **Gemini** free tier for `gemini-flash-latest`: ~10 requests/min, ~1,500/day
  (per Google project, resets midnight Pacific). Do **not** pin the
  `gemini-3.6-flash` preview release — its free tier is ~20 requests/day.
  On a 429 the assistant shows a friendly "try again shortly" / "try again
  tomorrow" message — never a raw error, never a bill. Real portfolio traffic
  won't come close; rapid manual testing will.
- The function caps message + conversation length. For hard per-visitor rate
  limiting add Upstash Redis (`@upstash/ratelimit`) — overkill at this scale.

### If Gemini's free limits prove too tight — switch to Groq

Groq's free tier is much roomier (~1,000 req/day, 30 req/min for Llama 3.3 70B)
and very fast. The system prompt already keeps it on-topic. To switch:

1. Get a free key at <https://console.groq.com/keys> (no card).
2. `vercel env add GROQ_API_KEY` (Secret, Production).
3. In `api/chat.js`, swap the `upstreamUrl` + request body for Groq's
   OpenAI-compatible endpoint:
   - URL: `https://api.groq.com/openai/v1/chat/completions`
   - Header: `Authorization: Bearer ${process.env.GROQ_API_KEY}`
   - Body: `{ model: "llama-3.3-70b-versatile", stream: true, messages: [{role:"system",content:SYSTEM_PROMPT}, ...history] }`
   - Parse SSE: `obj.choices[0].delta.content` instead of Gemini's `parts[].text`.
4. `vercel --prod`.
