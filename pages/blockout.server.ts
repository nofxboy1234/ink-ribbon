import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "RPD — wireframe blockout",
  meta: [
    {
      name: "description",
      content:
        "The Raccoon Police Department floors 1–3 as a simplified white wireframe of the original geometry, rendered with sokol and WebAssembly.",
    },
    { name: "theme-color", content: "#000000" },
  ],
}));
