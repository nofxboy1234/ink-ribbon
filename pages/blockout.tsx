import RpdScene from "../src/RpdScene";
import "./style.css";

export default function Page() {
  return (
    <RpdScene
      assetUrl="/rpd/blockout.bin"
      label="RPD floors one to three as a grey blockout"
    />
  );
}
