import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "RPD — floors 1–3",
  meta: [
    {
      name: "description",
      content:
        "A pannable, rotatable white-wireframe map of the Raccoon Police Department floors 1–3, rendered with sokol and WebAssembly.",
    },
    { name: "theme-color", content: "#000000" },
  ],
}));
