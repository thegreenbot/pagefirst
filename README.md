# Page-first editor, Google Doc as the source

An authenticated editing surface for a site whose pages live in Google Docs. The author changes words, images, and layout on a preview of the page. Commit writes those changes back into the Doc. Publish renders the last committed revision to static files and uploads them to Cloudflare.

Google is the only sign-in. A person can edit a page when Google says they can edit that Doc.

This repository currently holds the implementation plan. The app is not scaffolded yet.

Read [PLAN.md](./PLAN.md) before writing code. It is the contract for the content model, the commit path, publish, and the order of slices.
