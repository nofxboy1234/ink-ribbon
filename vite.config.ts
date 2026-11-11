import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidReact } from "@void/react/plugin";

export default defineConfig({
  // The SSR/worker bundles are minified too: they ship to the edge, so parse
  // time and cold start matter even though the browser never downloads them.
  build: { minify: true },
  plugins: [
    voidPlugin(),
    voidReact({ react: { compiler: true } }),
  ],
});
