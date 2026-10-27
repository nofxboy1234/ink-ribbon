import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "RPD — wireframe blockout",
  meta: [
    {
      name: "description",
      content:
        "The Raccoon Police Department floors 1–3 as a simplified blockout built from the original room geometry, rendered with sokol and WebAssembly.",
    },
    { name: "theme-color", content: "#000000" },
  ],
}));
