# shagun0915.github.io

Personal portfolio — a single static `index.html`, served by GitHub Pages.

It also has an **AI assistant** (bottom-right chat bubble) that answers questions
about Shagun. The static site can't hold an API key, so the chat calls a small
serverless function on **Vercel** that talks to **Google Gemini**.

```
Browser (GitHub Pages)  ──POST /api/chat──▶  Vercel Edge Function  ──▶  Gemini 3.6 Flash
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
**`shagun-portfolio-two.vercel.app`**.

### 5. Point the widget at your function
In `index.html`:

```js
var VERCEL_HOST = 'shagun-portfolio-two.vercel.app';
```

(host only, no `https://`). Commit and push — GitHub Pages redeploys the site.

### 6. Smoke-test

```bash
curl -s -X POST https://shagun-portfolio-two.vercel.app/api/chat \
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
- **Gemini** free tier: ~15 req/min, ~1,500 req/day. When the daily quota is
  hit the assistant politely says so and recovers the next day — no bill.
- The function caps message length and conversation length to keep abuse cheap.
  For hard per-visitor rate limiting, add Upstash Redis (see Vercel's
  `@upstash/ratelimit` guide) — not required at portfolio traffic.
