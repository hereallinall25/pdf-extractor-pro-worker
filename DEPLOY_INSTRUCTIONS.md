# Deployment Guide: Fix AI Hallucination Issue

## What changed
We updated the AI parameters in `pdf-extractor-pro-worker/src/vertexAi.js` to fix the issue where it generated subjects (like Dermatology, Venereology, Leprosy) that were not present in your PDF. This happened because the AI was trying to fulfill the instruction "Extract EVERY SINGLE ONE" by hallucinating content from its training knowledge.
1. Set the AI's `temperature` to `0.0` (makes answers strict and deterministic).
2. Added a critical prompt instruction forbidding the AI from hallucinating or generating papers not explicitly in the document.

## How to deploy

### 1. Git Push (Source Control)
Commit and push your changes to save them to your repository:
```bash
cd /Users/mdk/.gemini/antigravity/scratch/pdf-extractor-pro-worker
git add src/vertexAi.js
git commit -m "fix(ai): lower temperature to 0.0 and prevent data hallucination"
git push origin main
```

### 2. Deploy to Hosted Area (Cloudflare Workers)
Since this is a Cloudflare Worker, you will deploy it using your wrangler CLI:
```bash
cd /Users/mdk/.gemini/antigravity/scratch/pdf-extractor-pro-worker
npx wrangler deploy
```

Once the deploy completes, the new strict rules will immediately apply to any new PDFs you upload from the frontend.
