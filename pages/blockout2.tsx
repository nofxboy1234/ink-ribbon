import RpdScene from "../src/RpdScene";
import "./style.css";

export default function Page() {
  return (
    <RpdScene
      assetUrl="/rpd/rpd.bin"
      mode="blockout2"
      label="The original RPD geometry rendered as a white wireframe"
    />
  );
}
