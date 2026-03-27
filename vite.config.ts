import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "^/tradingview/.*": {
        target: "https://assets.staticimg.com/natasha/npm/kline/trading_platform_29/",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tradingview/, ""),
      }
    }
  }
});
