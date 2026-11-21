import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// NOTE: vite-plugin-css-modules was removed. Vite has first-class CSS Modules
// support built in — adding the plugin alongside it causes the two systems to
// produce different scoped class names between dev and production builds,
// which breaks any component that relies on CSS Modules (e.g. flexbox layouts
// disappear in prod because the generated class names no longer match).
// The built-in `css.modules` options below are the only configuration needed.

export default defineConfig({
  plugins: [react()],
  css: {
    modules: {
      // camelCase lets components use styles.myClass instead of styles['my-class']
      localsConvention: "camelCase",
      // Stable, human-readable scoped names in both dev and prod builds.
      // Using the same pattern for both environments guarantees the class
      // names that JS reads always match what the CSS file emits.
      generateScopedName: "[name]__[local]___[hash:base64:5]",
    },
    devSourcemap: true,
  },
  build: {
    // Disable CSS code splitting — when CSS is split into per-component chunks,
    // mobile browsers can fail to load individual chunks in the correct order,
    // causing CSS Modules scoped class names to mismatch and flexbox layouts
    // to break in production builds (fixes #155).
    cssCodeSplit: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
