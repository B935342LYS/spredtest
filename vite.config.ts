import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    // 실제 번들 의존성 고지를 매 빌드에 포함해 수동 고지 목록과 대조한다.
    license: { fileName: "licenses/bundled-dependencies.md" },
  },
});
