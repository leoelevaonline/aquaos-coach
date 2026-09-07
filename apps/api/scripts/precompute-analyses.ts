import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { analyzeVideo } from "../src/video-analysis.js";

const root = fileURLToPath(new URL("../storage/uploads/", import.meta.url));
const outDir = fileURLToPath(new URL("../storage/analyses/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const targets = [
  { id: "video-treino-diurno", filename: "treino-tecnico-diurno-1080p.mp4", thumb: "treino-tecnico-diurno-1080p-thumb.jpg" },
  { id: "video-treino-noturno", filename: "treino-tecnico-noturno-720p.mp4", thumb: "treino-tecnico-noturno-720p-thumb.jpg" },
];

for (const target of targets) {
  console.log(`Analisando ${target.filename}...`);
  const analysis = await analyzeVideo(resolve(root, target.filename), resolve(root, target.thumb));
  writeFileSync(resolve(outDir, `${target.id}.json`), JSON.stringify(analysis, null, 2), "utf8");
  console.log(`-> ${target.id}.json | ciclos: ${analysis.metrics.detectedCycles} | cadência: ${analysis.metrics.estimatedCadence}`);
}
console.log("Concluído.");
