import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "RPD — Dracula blockout",
  meta: [
    {
      name: "description",
      content:
        "The Raccoon Police Department floors 1–3 as a desaturated Dracula-coloured blockout, rendered with sokol and WebAssembly.",
    },
    { name: "theme-color", content: "#000000" },
  ],
}));
