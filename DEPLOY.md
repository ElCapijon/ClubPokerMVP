# Poker Club — Deployment Guide

## Architecture

The Poker Club app uses a **single-service deployment** where the Node.js backend serves both the API/WebSocket endpoints **and** the built React frontend. This avoids CORS issues and simplifies SSL/WSS setup.

```
Browser ──https/wss──→ Render.com ──→ Node.js (Express + Socket.io)
                                          │
                                          └──→ Neon PostgreSQL
```

## Option 1: Deploy to Render.com (Recommended — Free Tier)

### Prerequisites

1. A [Render account](https://render.com) (free tier: 750 hours/month)
2. A [Neon account](https://neon.tech) with your PostgreSQL database (you already have this)
3. Your Neon database connection string (starts with `postgresql://...`)

### Step 1: Push your code to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
# Create a repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/poker-club.git
git push -u origin main
```

### Step 2: Create a Web Service on Render

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**
2. Connect your GitHub repository
3. Configure the service:

| Setting | Value |
|---------|-------|
| **Name** | `poker-club` (or your choice) |
| **Region** | Oregon (closest to Neon's US East region) |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm start` |
| **Plan** | Free |

4. Add the required **Environment Variables**:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgresql://neondb_owner:...@ep-...aws.neon.tech/neondb?sslmode=require` |
| `PORT` | `3000` (Render injects this automatically) |

> **Important:** Copy your Neon connection string exactly. Make sure it includes `?sslmode=require` at the end.

5. Click **Deploy Web Service**

### Step 3: Wait for the build

Render will:
1. Install dependencies (`npm install` → installs backend + builds frontend)
2. Build the frontend (`npm run build`)
3. Start the server (`npm start`)

After ~2-3 minutes, you'll see: `"[Server] Poker Club running on port 10000"`

### Step 4: Run the database migration

You need to create the database tables. Connect via SSH into your Render service:

```bash
# Option A: Use Render's Shell (from dashboard → your service → Shell)
cd backend && node migrate.js

# Option B: Run locally with the production DATABASE_URL
DATABASE_URL="your-neon-connection-string" node backend/migrate.js
```

### Step 5: Access your app

Your app will be live at: `https://poker-club.onrender.com` (or whatever name you chose)

Render automatically provisions SSL certificates, so WebSocket connections will use **`wss://`** automatically.

### Render Free Tier Notes

- **Idle spin-down:** The service spins down after **15 minutes of inactivity**. The first connection after idle takes ~30-60 seconds to boot up. This is normal for the free tier.
- **You can use [uptimerobot.com](https://uptimerobot.com) (free)** to ping the `/api/health` endpoint every 10 minutes to prevent spin-down.
- **750 hours/month** = 24/7 for 31 days. Since the free tier spins down when idle, you'll likely stay well under this limit.

---

## Option 2: Deploy to Railway.app (Alternative)

Railway keeps services running 24/7 without spin-down, but requires a paid plan after the free trial.

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize
railway init

# Set environment variables
railway env set NODE_ENV=production
railway env set DATABASE_URL=your-neon-connection-string

# Deploy
railway up
```

---

## Post-Deployment Verification

After deployment, verify everything works:

```bash
# 1. Health check
curl https://poker-club.onrender.com/api/health
# → { "status": "ok", "timestamp": ... }

# 2. The frontend loads
curl https://poker-club.onrender.com/
# → Should return the HTML page

# 3. Open in browser and test:
#    - Create a club → note the invite code
#    - Open a second tab → join with that code
#    - Both players should see each other
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | Yes | Set to `production` for deployment |
| `DATABASE_URL` | Yes | Neon PostgreSQL connection string |
| `PORT` | No | Server port (Render sets this automatically) |
| `CORS_ORIGIN` | No | Override CORS origin (not needed in production) |

---

## Troubleshooting

### "WebSocket connection failed"
- Ensure you're using `https://` in the browser (not `http://`)
- Render's free tier doesn't support custom domains with SSL on the free plan, so use the `*.onrender.com` URL
- Check that WebSocket transport isn't being blocked by a firewall/proxy

### "Database connection error"
- Verify the `DATABASE_URL` ends with `?sslmode=require`
- Check that your Neon database IP allowlist includes `0.0.0.0/0` (allow all) or Render's egress IPs
- Ensure the database isn't paused (Neon free tier pauses after 5 hours of inactivity — visit your Neon console to unpause)

### "Build failed"
- Check the Render build logs for errors
- Make sure all dependencies are listed in `package.json`
- Ensure Node version compatibility (Render uses Node 18+ by default)

### "504 Gateway Timeout"
- This happens when the service is spinning up from idle. Wait 30-60 seconds and refresh.

---

## Updating Your App

1. Make changes locally
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Description of changes"
   git push
   ```
3. Render automatically redeploys on push to the connected branch

---

## Scaling Beyond Free Tier

When you're ready to scale:

1. **Upgrade Render plan** — $7/month for Web Services (no spin-down)
2. **Add a managed Postgres** — Render offers managed Postgres (starts at $7/month)
3. **Add Redis** — For horizontal scaling with Socket.io (use the Redis adapter)
4. **Custom domain** — Add your own domain with SSL
