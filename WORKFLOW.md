# Claude Web App Deployment Workflow
*A reusable pattern for building and auto-deploying web apps with Claude*

---

## Overview

This workflow lets Claude build, update, and deploy web applications directly —
no manual file handling, no downloads, no terminal commands from the user.

**Stack:**
- Code lives in **GitHub** (Curious07Cress)
- Hosting on **Cloudflare Workers** (free, unlimited bandwidth)
- Claude pushes updates directly via **GitHub API**
- Cloudflare auto-deploys within ~60 seconds of every GitHub commit

---

## Credentials (provide fresh each session)

| What | Where to get it | Notes |
|------|----------------|-------|
| GitHub token | github.com/settings/tokens → Classic → `repo` scope | Rotate after each session |
| Cloudflare Account ID | `526b45895f0cf4578e1baa158411a90d` | Not a secret |
| Cloudflare token | dash.cloudflare.com/profile/api-tokens | Rotate after each session |

**Security rule:** Never reuse tokens across sessions. Generate fresh, use, rotate.

---

## Existing Projects

| App | GitHub Repo | Live URL | Stack |
|-----|------------|----------|-------|
| Spa Assistant | Curious07Cress/spa-assistant | spa-assistant.erichasan.workers.dev | HTML/CSS/JS PWA, Open-Meteo weather, Anthropic API |

---

## Starting a New Project — Checklist

### 1. Create GitHub repo
- Go to github.com → New repository
- Name it (kebab-case, e.g. `my-app`)
- Public, no README
- Note the repo name

### 2. Tell Claude
> "I want to build [description]. GitHub token: ghp_xxx. Repo: Curious07Cress/my-app."

Claude will:
- Build the full app (single HTML file for simple apps)
- Push all files to GitHub via API
- Confirm commit SHA

### 3. Set up Cloudflare Worker
- dash.cloudflare.com → Workers & Pages → Create
- Choose "Worker" → name it to match repo
- Deploy once manually (paste index.html content)
- From that point, GitHub pushes auto-deploy via the connected Worker

### 4. Add to project table above
Update this WORKFLOW.md to record the new app.

---

## Claude Push Workflow (what Claude does each update)

```bash
# 1. Get current file SHA (required for GitHub API updates)
SHA=$(curl -s -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/Curious07Cress/$REPO/contents/index.html" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha',''))")

# 2. Base64 encode the updated file
CONTENT=$(base64 < index.html | tr -d '\n')

# 3. Commit via GitHub API
curl -s -X PUT \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Update: $DESCRIPTION\",\"content\":\"$CONTENT\",\"sha\":\"$SHA\"}" \
  "https://api.github.com/repos/Curious07Cress/$REPO/contents/index.html"
```

---

## App Architecture Patterns

### Simple PWA (single file)
- One `index.html` with embedded CSS and JS
- `manifest.json` for installability
- `sw.js` for offline support
- Two PNG icons (192px, 512px)

### With AI (Anthropic API in browser)
```javascript
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': userApiKey,  // user provides, stored in localStorage
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: conversationHistory
  })
});
```

### With Live Data (no API key needed)
- Weather: `api.open-meteo.com` — free, no key, global coverage
- Location: browser `navigator.geolocation`
- Time/timezone: `worldtimeapi.org`

---

## Design System

All apps use this consistent dark theme:

```css
:root {
  --bg: #0a1628;        /* deep navy background */
  --card: #1a2d50;      /* card surface */
  --accent: #4fc3f7;    /* cyan accent */
  --text: #e8f4fd;      /* primary text */
  --text2: #90b8d8;     /* secondary text */
  --text3: #5a8aaa;     /* muted text */
  --ok: #4caf7d;        /* green / good */
  --warn: #ffb74d;      /* amber / warning */
  --danger: #ef5350;    /* red / danger */
  --border: rgba(79,195,247,0.12);
  --radius: 16px;
  --radius-sm: 10px;
}
```

Mobile-first. Max width 480px. iOS safe area aware. No external CSS frameworks.

---

## How to Start a New Chat

Paste this to Claude at the start of any session:

```
Read my workflow doc:
https://raw.githubusercontent.com/Curious07Cress/spa-assistant/main/WORKFLOW.md

GitHub token: ghp_[your-fresh-token]

I want to [describe what you want to build or update].
```

Claude will fetch the doc, have full context, and begin immediately.

---

## Ideas Backlog
*(add future app ideas here)*

- [ ] ...

---

*Last updated: June 2026*
