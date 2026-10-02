import { WasmCanvas } from "../src/game/WasmCanvas";
import { CraftingPanel } from "../src/menus/CraftingPanel";
import { FilesPanel } from "../src/menus/FilesPanel";
import { ItemsPanel } from "../src/menus/ItemsPanel";
import type { Props } from "./index.server";
import "./styles.css";

export default function HomePage(_props: Props) {
  return (
    <main className="game-shell">
      <section className="map-region" aria-label="Care Center map">
        <WasmCanvas />
      </section>
      <aside className="menu-region">
        <ItemsPanel />
        <CraftingPanel />
        <FilesPanel />
      </aside>
    </main>
  );
}
