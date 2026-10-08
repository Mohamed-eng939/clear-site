# CLEAR English Academy website

The public site is a single page: `public/index.html`.

Cloudflare publishes the `main` branch to the `clearacademy` Worker.
`wrangler.jsonc` tells it to serve everything in `public/`.
To change the site, change `public/index.html` and push to `main`.
