import { defineConfig } from 'void/config';

export default defineConfig({
  target: 'cloudflare',
  cloudflare: {
    name: 'ink-ribbon',
  },
  worker: {
    compatibility_date: '2026-02-24',
  },
  routing: {
    headers: {
      "/": ["Cache-Control: no-cache"],
      "/*.html": ["Cache-Control: no-cache"],
    },
  },
});
