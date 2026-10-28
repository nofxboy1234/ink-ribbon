import RpdScene from "../src/RpdScene";
import "./style.css";

export default function Page() {
  return (
    <RpdScene
      assetUrl="/rpd/simple.bin"
      label="Simplified RPD entrance"
    />
  );
}
