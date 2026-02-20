# Deployment Guide: Configurable Temperature & Batch Processing

## What changed
We added new controls to the frontend so you can adjust settings without modifying code:
1. **AI Temperature Slider**: Set anywhere from `0.0` (strict/factual) to `1.0` (creative).
2. **Batch Processing Size**: Change how many PDFs process at the exact same time. You can set it to `1` to carefully process them one by one, or higher for speed.

We also updated the `pdf-extractor-pro-worker` backend to read the AI Temperature that you select on the UI and feed it dynamically into Gemini 2.5 Flash Lite.

## How to deploy

### 1. Git Push (Source Control)
Commit and push both the frontend and worker changes:
```bash
# Push Worker Changes
cd /Users/mdk/.gemini/antigravity/scratch/pdf-extractor-pro-worker
git add src/index.js src/vertexAi.js DEPLOY_INSTRUCTIONS_BATCH.md
git commit -m "feat(ai): dynamic temperature setting from frontend"
git push origin main

# Push Frontend Changes
cd /Users/mdk/.gemini/antigravity/scratch/pdf-extractor-pro-frontend
git add src/App.jsx
git commit -m "feat(ui): add temperature slider and batch size inputs"
git push origin main
```

### 2. Deploy to Hosted Area (Cloudflare)
Deploy the Worker:
```bash
cd /Users/mdk/.gemini/antigravity/scratch/pdf-extractor-pro-worker
npx wrangler deploy
```

Deploy the Frontend:
```bash
cd /Users/mdk/.gemini/antigravity/scratch/pdf-extractor-pro-frontend
npx wrangler pages deploy dist
```
*(Make sure you run `npm run build` before deploying the frontend if required by your setup).*
