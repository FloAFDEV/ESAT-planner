import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/") ||
            id.includes("loose-envify") ||
            id.includes("object-assign") ||
            id.includes("react-is") ||
            id.includes("use-sync-external-store")
          ) {
            return "react-vendor";
          }

          if (id.includes("@tanstack")) {
            return "tanstack-vendor";
          }

          if (id.includes("@supabase")) {
            return "supabase-vendor";
          }

          if (id.includes("@radix-ui")) {
            return "radix-vendor";
          }

          if (id.includes("lucide-react")) {
            return "icons-vendor";
          }

          if (id.includes("recharts")) {
            return "charts-vendor";
          }

          if (id.includes("sonner")) {
            return "feedback-vendor";
          }

          if (id.includes("date-fns") || id.includes("zod")) {
            return "data-vendor";
          }

          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  optimizeDeps: {
    include: ["@tanstack/react-query"]
  }
});