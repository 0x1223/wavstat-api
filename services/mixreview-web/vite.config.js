import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";

  return {
    plugins: [
      react(),
      {
        // Vite injects crossorigin on both the module script and the CSS link
        // in the production build.  crossorigin is correct for the script
        // (required for modulepreload / subresource integrity).  It is NOT
        // correct for the CSS link when assets are same-origin: it forces a
        // CORS-mode fetch which fails silently if the server does not emit
        // Access-Control-Allow-Origin.  The Vite dev server adds CORS headers
        // automatically; most production hosts do not for static assets.
        // After iOS deep-sleep eviction the HTTP cache is cleared, so the
        // browser re-fetches the CSS in CORS mode — and it fails, leaving the
        // app with no stylesheet.  Stripping crossorigin from the CSS link
        // restores normal same-origin fetching for the stylesheet only.
        name: "strip-stylesheet-crossorigin",
        transformIndexHtml(html) {
          return html.replace(
            /(<link[^>]+rel="stylesheet"[^>]*)\scrossorigin(?:="[^"]*")?/g,
            "$1",
          );
        },
      },
    ],
    base: "/",
    build: {
      outDir: "dist",
      assetsDir: "assets",
      emptyOutDir: true,
      sourcemap: false
    },
    preview: {
      host: "0.0.0.0",
      port: 4300
    },
    server: {
      host: "0.0.0.0",
      port: 4300,
      strictPort: false,
      proxy: isProduction
        ? undefined
        : {
            "/api": "http://localhost:4301",
            "/uploads": "http://localhost:4301"
          }
    }
  };
});
