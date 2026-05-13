import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";

  return {
    plugins: [react()],
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
