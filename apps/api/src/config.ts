import type { StorageEngine } from "@ata/contracts";

/**
 * Local, hardcoded project + API-key concept (docs/architecture.md §12). Fine for
 * a local prototype per the brief; documented as a non-goal to do real auth.
 */
export interface ProjectConfig {
  projectId: string;
  apiKey: string;
  name: string;
}

export const DEV_PROJECTS: ProjectConfig[] = [
  { projectId: "proj_dev", apiKey: "dev_project_key", name: "Local Dev" },
];

/** Resolve an API key to a project id, or null if unknown. */
export function resolveProjectId(apiKey: string): string | null {
  return DEV_PROJECTS.find((p) => p.apiKey === apiKey)?.projectId ?? null;
}

/** Active storage engine; swappable via env (defaults to DuckDB). */
export const STORAGE_ENGINE: StorageEngine =
  process.env.ATA_ENGINE === "clickhouse" ? "clickhouse" : "duckdb";

export const API_PORT = Number(process.env.ATA_PORT ?? 3000);
