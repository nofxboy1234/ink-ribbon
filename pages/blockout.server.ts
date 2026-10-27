import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "RPD — greybox",
  meta: [
    {
      name: "description",
      content:
        "A grey blockout of the Raccoon Police Department floors 1–3: cubic walls and floor plates with triangular stair ramps, rendered with sokol and WebAssembly.",
    },
    { name: "theme-color", content: "#000000" },
  ],
}));
