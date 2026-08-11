import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  projectBrainDir: string;
  stageDelayMs: number;
  defaultRuntime: string;
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? "8787"),
    dataDir: resolve(process.env.DATA_DIR ?? "./data"),
    projectBrainDir: resolve(process.env.PROJECT_BRAIN_DIR ?? "./project-brain"),
    stageDelayMs: Number(process.env.DEMO_STAGE_DELAY_MS ?? "1200"),
    defaultRuntime: process.env.DEFAULT_RUNTIME ?? "atomic",
  };
}

export function loadProjectSeed(): Array<Record<string, unknown>> {
  const path = resolve("./config/projects.json");
  return JSON.parse(readFileSync(path, "utf8"));
}
