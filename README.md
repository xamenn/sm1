# sm1 — anonymous stranger chat

Talk to someone. No account. No history.

---

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two browser tabs to test the matchmaking.

---

## Deploy to Railway

1. Push this folder to a GitHub repo

```bash
git init
git add .
git commit -m "init sm1"
git remote add origin https://github.com/YOUR_USERNAME/sm1.git
git push -u origin main
```

2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo → select `sm1`

3. Railway auto-detects Node.js and runs `npm start`

4. Go to Settings → Networking → Generate Domain → you get your free URL

5. Set environment variables in Railway dashboard under Variables:

| Key | Value |
|-----|-------|
| `PORT` | (Railway sets this automatically — leave it) |
| `ALLOWED_ORIGIN` | `https://sm1.online` (once you have your domain) |

6. Point your domain `sm1.online` to Railway via a CNAME record in your domain registrar's DNS settings — Railway shows you the exact value under Settings → Networking

---

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `ALLOWED_ORIGIN` | Allowed WebSocket origin (set to your domain in prod) | `null` (allows all) |

---

## Security features

- XSS protection — all user input is escaped before rendering
- Rate limiting — max 5 messages per 3 seconds per user
- Message length cap — 500 characters max
- Origin check — restrict connections to your domain in production
- Heartbeat — dead connections are cleaned up every 30 seconds

---

## File structure

```
sm1/
├── server.js      — WebSocket server + HTTP server + matchmaking
├── index.html     — Full chat UI
├── package.json   — Dependencies
└── README.md      — This file
```

---

## Legal reminder

Before going public, add to your `index.html`:
- A visible "You must be 18+" notice on the page
- A link to your Terms of Service
- A link to your Privacy Policy
- An abuse report email (e.g. abuse@sm1.online)

Free ToS/Privacy Policy generators: [termly.io](https://termly.io) or [getterms.io](https://getterms.io)
