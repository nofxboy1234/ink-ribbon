// Build the acceptance GIFs from the timeline written by tools/acceptance.mjs.
// Each frame carries its own delay, so the camera moves play as a time-lapse
// while the menu and item moments play at real speed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, process.argv[2] ?? "verification/rpd/acceptance");
const timeline = JSON.parse(readFileSync(join(dir, "timeline.json"), "utf8"));
const width = Number(process.env.GIF_WIDTH ?? 1000);

for (const view of ["ortho", "persp"]) {
  const frames = timeline[view];
  if (!frames?.length) continue;
  const list = frames
    .map((frame) => `file '${join(dir, frame.file)}'\nduration ${(frame.ms / 1000).toFixed(3)}`)
    .join("\n");
  const listPath = join(dir, `${view}-frames.txt`);
  writeFileSync(listPath, `${list}\nfile '${join(dir, frames.at(-1).file)}'\n`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-vf",
      `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
      "-loop", "0",
      join(dir, `rpd-${view}.gif`),
    ],
    { stdio: "inherit" },
  );
  rmSync(listPath, { force: true });
  console.log(`built rpd-${view}.gif from ${frames.length} frames`);
}
