import { defineHead } from "void";

export const head = defineHead(() => ({
  title: "RPD — floors 1–3",
  meta: [
    {
      name: "description",
      content:
        "An interactive 3D view of the Raccoon Police Department floors 1–3, built from the real level geometry with flat material colours and rendered with sokol and WebAssembly.",
    },
    { name: "theme-color", content: "#000000" },
  ],
}));
