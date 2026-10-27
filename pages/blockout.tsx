import RpdScene from "../src/RpdScene";
import "./style.css";

export default function Page() {
  return (
    <RpdScene
      assetUrl="/rpd/rpd.bin"
      mode="blockout"
      label="The original RPD geometry as a simplified white wireframe"
    />
  );
}
