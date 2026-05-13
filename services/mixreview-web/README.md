# MixReview Web

React/Vite frontend for the MixReview music review workspace.

## Deployment Target

- Custom domain: `https://mixreview.kingzbreadent.com`
- Build output: `dist`
- Static assets: `dist/assets`

## Environment

Frontend environment variables are separate from API secrets. Do not place R2
credentials in the frontend environment.

Copy `.env.example` or `.env.production.example` and configure:

- `VITE_APP_ORIGIN=https://mixreview.kingzbreadent.com`
- `VITE_API_BASE_URL` optional, set to the deployed Railway API URL when the API
  is hosted on a separate domain. Leave blank if `/api` is routed to the API by
  a reverse proxy or edge rule.

Frontend API calls should use `src/config/api.js`, which resolves paths against
`VITE_API_BASE_URL` when it is configured.

## Local Development

```bash
npm install
npm run dev
```

The Vite dev server proxies `/api` and `/uploads` to
`http://localhost:4301`.

## Production Build

```bash
npm run build
npm run preview -- --host 0.0.0.0 --port 4300
```

Railway can deploy this service from `services/mixreview-web` using
`railway.toml`.
