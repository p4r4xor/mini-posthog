/**
 * @ata/contracts — the single source of truth for the types and schemas shared
 * across the SDK, ingestion/query API, storage adapters, and the web app.
 *
 * Layers (docs/architecture.md §4):
 *   - common      : shared primitives/enums
 *   - events      : wire DTO (CaptureEvent union) + capture request/response
 *   - query-plan  : the QueryPlan IR (NL ↔ engine contract)
 *   - query-result: QueryResult returned to the frontend
 *   - storage     : EventRow, rollups, CompiledQuery, EventStore port
 *   - mappers     : canonical cross-layer translations
 */
export * from "./common.js";
export * from "./events.js";
export * from "./mappers.js";
export * from "./query-plan.js";
export * from "./query-result.js";
export * from "./storage.js";
