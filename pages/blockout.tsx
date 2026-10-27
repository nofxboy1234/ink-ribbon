import RpdScene from "../src/RpdScene";
import "./style.css";

export default function Page() {
  return (
    <RpdScene
      assetUrl="/rpd/blockout.bin"
      mode="blockout"
      label="RPD floors one to three as a white wireframe blockout"
    />
  );
}
