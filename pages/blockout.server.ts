import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "RPD — greybox",
  meta: [
    {
      name: "description",
      content:
        "The Raccoon Police Department floors 1–3 as a plain grey blockout, rendered with sokol and WebAssembly.",
    },
    { name: "theme-color", content: "#000000" },
  ],
}));
