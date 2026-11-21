# Page-first editor

A reviewable plan for an editor whose pages live in Google Docs. The author changes words, images, and layout on a preview. Commit writes those changes back into the Doc. Publish renders the last committed revision to static files and uploads them to Cloudflare.

Google is the only sign-in. A person can edit a page when Google says they can edit that Doc.

This site is the plan itself. The editor is specified in [PLAN.md](./PLAN.md) and has not been built yet.

## Run locally

```bash
npm install
npm run dev
```

The dev server listens on port 3847. Open [http://127.0.0.1:3847](http://127.0.0.1:3847).

```bash
npm run build
npm start
```
