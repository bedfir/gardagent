import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The gateway serves the console under /console/; in development, /admin is proxied to the local gateway.
export default defineConfig({
  base: "/console/",
  plugins: [vue()],
  server: {
    proxy: {
      "/admin": "http://localhost:8080",
    },
  },
});
