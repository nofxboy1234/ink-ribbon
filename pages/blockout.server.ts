import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "RPD — pastel blockout",
  meta: [
    {
      name: "description",
      content:
        "The Raccoon Police Department floors 1–3 as a pastel-coloured blockout, rendered with sokol and WebAssembly.",
    },
    { name: "theme-color", content: "#000000" },
  ],
}));
