import RpdScene from "../src/RpdScene";
import "./style.css";

export default function Page() {
  return (
    <RpdScene
      assetUrl="/rpd/simple2.bin"
      label="RPD blockout, floors 1 to 3"
    />
  );
}
