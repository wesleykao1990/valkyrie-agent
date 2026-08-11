import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const key = process.env.TRANSCRIPT_API_KEY;
if (!key) {
  console.error("TRANSCRIPT_API_KEY is not set. Store it outside chat, export it, then rerun.");
  process.exit(2);
}

const videos = [
  "https://www.youtube.com/watch?v=pKzG2h5J7e0",
  "https://www.youtube.com/watch?v=XPQaoEZa9Y4",
];
const outDir = fileURLToPath(new URL("../research/video-transcripts/", import.meta.url));
await mkdir(outDir, { recursive: true });

for (const videoUrl of videos) {
  const id = new URL(videoUrl).searchParams.get("v");
  const endpoint = new URL("https://transcriptapi.com/api/v2/youtube/transcript");
  endpoint.searchParams.set("video_url", videoUrl);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("include_timestamp", "true");
  endpoint.searchParams.set("send_metadata", "true");

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${key}`,
      "User-Agent": "WesleyAtomicWorkflowArchitect/0.2.1",
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Transcript request failed for ${id}: ${response.status} ${body.slice(0, 500)}`);
  }
  await writeFile(join(outDir, `${id}.json`), body, "utf8");
  console.log(`Saved ${id}.json`);
}
