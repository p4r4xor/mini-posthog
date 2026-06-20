/**
 * Reporting: a readable console table comparing engines side by side, plus a
 * machine-readable `results.json` for docs/architecture.md §8.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StorageEngine } from "@ata/contracts";
import { RESULTS_DIR } from "./engines.js";
import type { QueryTiming } from "./run-bench.js";

export interface EngineSummary {
  engine: StorageEngine;
  rowsLoaded: number;
  loadMs: number;
  ingestEventsPerSec: number;
  diskBytes: number;
  rawBytes: number;
  compressionRatio: number;
  timings: QueryTiming[];
}

export interface BenchResults {
  generatedAt: string;
  events: number;
  iterations: number;
  days: number;
  seed: number;
  traces: number;
  generateMs: number;
  engines: EngineSummary[];
}

const fmtMs = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : "—");
const fmtInt = (n: number): string => n.toLocaleString("en-US");

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(2)} ${units[i]}`;
}

/** Pad a string to width (right-pad for left-align, left-pad for right-align). */
function pad(s: string, w: number, align: "l" | "r" = "l"): string {
  if (s.length >= w) return s;
  const fill = " ".repeat(w - s.length);
  return align === "l" ? s + fill : fill + s;
}

/** Print the per-query p50/p95 comparison table + the summary block. */
export function printReport(results: BenchResults): void {
  const engines = results.engines;
  const queryNames = engines[0]?.timings.map((t) => t.nl) ?? [];

  console.log("");
  console.log("=".repeat(100));
  console.log(
    `BENCHMARK — ${fmtInt(results.events)} events target · ${fmtInt(results.traces)} traces · ` +
      `${results.iterations} iterations · ${results.days}d window · seed ${results.seed}`,
  );
  console.log("=".repeat(100));

  // ---- Per-query latency table ----
  const nameW = Math.max(28, ...queryNames.map((n) => n.length));
  const lvlW = 6;
  const cellW = 11;

  let header = `${pad("query", nameW)}  ${pad("level", lvlW)}`;
  for (const e of engines) {
    header += `  ${pad(`${e.engine} p50`, cellW, "r")}  ${pad(`${e.engine} p95`, cellW, "r")}`;
  }
  header += `  ${pad("rows", 8, "r")}`;
  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));

  for (let i = 0; i < queryNames.length; i++) {
    const nl = queryNames[i]!;
    const level = engines[0]?.timings[i]?.level ?? "events";
    let line = `${pad(nl, nameW)}  ${pad(level, lvlW)}`;
    let rows = 0;
    for (const e of engines) {
      const t = e.timings[i];
      line += `  ${pad(t ? fmtMs(t.p50Ms) : "—", cellW, "r")}  ${pad(t ? fmtMs(t.p95Ms) : "—", cellW, "r")}`;
      if (t) rows = t.rowCount;
    }
    line += `  ${pad(fmtInt(rows), 8, "r")}`;
    console.log(line);
  }

  // ---- Summary block ----
  console.log("");
  console.log("SUMMARY");
  console.log("-".repeat(60));
  for (const e of engines) {
    console.log(`  [${e.engine}]`);
    console.log(`    rows loaded         ${fmtInt(e.rowsLoaded)}`);
    console.log(
      `    ingest throughput   ${fmtInt(Math.round(e.ingestEventsPerSec))} events/sec  (load ${fmtMs(e.loadMs)} ms)`,
    );
    console.log(`    on-disk size        ${fmtBytes(e.diskBytes)}`);
    console.log(
      `    compression ratio   ${e.compressionRatio.toFixed(2)}× vs raw JSON (${fmtBytes(e.rawBytes)})`,
    );
  }
  console.log("");
}

/** Write the full results object to bench/results/results.json. */
export function writeResults(results: BenchResults): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = resolve(RESULTS_DIR, "results.json");
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  return path;
}

/** Emit a Markdown p50/p95 table (handy to paste into docs §8). */
export function toMarkdown(results: BenchResults): string {
  const engines = results.engines;
  const queryNames = engines[0]?.timings.map((t) => t.nl) ?? [];

  let head = "| Query | Level |";
  let sep = "| --- | --- |";
  for (const e of engines) {
    head += ` ${e.engine} p50 (ms) | ${e.engine} p95 (ms) |`;
    sep += " ---: | ---: |";
  }
  const lines = [head, sep];
  for (let i = 0; i < queryNames.length; i++) {
    const level = engines[0]?.timings[i]?.level ?? "events";
    let row = `| ${queryNames[i]} | ${level} |`;
    for (const e of engines) {
      const t = e.timings[i];
      row += ` ${t ? t.p50Ms.toFixed(2) : "—"} | ${t ? t.p95Ms.toFixed(2) : "—"} |`;
    }
    lines.push(row);
  }
  return lines.join("\n");
}
