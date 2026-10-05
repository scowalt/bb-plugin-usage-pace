import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
  test: {
    projects: [
      { extends: true, test: { name: "dom", environment: "jsdom", include: ["app.test.tsx", "banked-resets.test.tsx", "lib/card-pace.test.ts"] } },
      { extends: true, test: { name: "node", environment: "node", include: ["*.test.ts", "*.test.tsx", "lib/*.test.ts"], exclude: [...configDefaults.exclude, ...["app.test.tsx", "banked-resets.test.tsx", "lib/card-pace.test.ts"]] } },
    ],
  },
});
