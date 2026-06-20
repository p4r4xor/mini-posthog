import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { EventStore, TraceFilter } from "@ata/contracts";
import { resolveProjectId } from "../config.js";
import { IngestionService } from "../ingestion/ingestion-service.js";
import { QueryService } from "../query/query-service.js";

/** Dependencies injected into the app — tests pass a :memory: store. */
export interface AppDeps {
  store: EventStore;
  ingestion: IngestionService;
  query: QueryService;
}

/** Project used for the query explorer in this single-tenant prototype. */
const EXPLORER_PROJECT_ID = "proj_dev";

interface CaptureBody {
  events?: unknown;
}

interface QueryBody {
  q?: unknown;
  timeRange?: { from: string; to: string };
  limit?: number;
}

interface TraceQuery {
  from?: string;
  to?: string;
  agentName?: string;
  model?: string;
  toolName?: string;
  status?: string;
  userId?: string;
  limit?: string;
  offset?: string;
}

/**
 * Build the Fastify app with all routes wired against the injected deps. Kept
 * separate from bootstrap so tests can inject a fresh in-memory store and use
 * `app.inject(...)` without binding a port.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));

  // --- Ingestion ---------------------------------------------------------
  app.post<{ Body: CaptureBody }>("/capture", async (req, reply) => {
    const apiKey = req.headers["x-api-key"];
    const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    const projectId = key ? resolveProjectId(key) : null;
    if (!projectId) {
      return reply.code(401).send({ error: "Invalid or missing x-api-key" });
    }

    const events = req.body?.events;
    if (!Array.isArray(events)) {
      return reply
        .code(400)
        .send({ error: "Request body must be { events: CaptureEvent[] }" });
    }

    const response = await deps.ingestion.capture(events, projectId);
    return reply.code(200).send(response);
  });

  // --- Query -------------------------------------------------------------
  app.post<{ Body: QueryBody }>("/query", async (req, reply) => {
    const q = req.body?.q;
    if (typeof q !== "string" || q.trim().length === 0) {
      return reply.code(400).send({ ok: false, reason: "Missing 'q'", supported: [] });
    }

    const result = await deps.query.run(q, {
      projectId: EXPLORER_PROJECT_ID,
      timeRange: req.body?.timeRange,
      limit: req.body?.limit,
    });

    if (!result.ok) {
      return reply
        .code(400)
        .send({ ok: false, reason: result.reason, supported: result.supported });
    }
    return reply
      .code(200)
      .send({ ok: true, source: result.source, result: result.result });
  });

  // --- Trace explorer ----------------------------------------------------
  app.get<{ Querystring: TraceQuery }>("/traces", async (req, reply) => {
    const q = req.query;
    const filter: TraceFilter = {
      projectId: EXPLORER_PROJECT_ID,
      from: q.from,
      to: q.to,
      agentName: q.agentName,
      model: q.model,
      toolName: q.toolName,
      status: q.status,
      userId: q.userId,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
      offset: q.offset !== undefined ? Number(q.offset) : undefined,
    };
    const traces = await deps.store.listTraces(filter);
    return reply.code(200).send(traces);
  });

  app.get<{ Params: { traceId: string } }>("/traces/:traceId", async (req, reply) => {
    const detail = await deps.store.getTrace(EXPLORER_PROJECT_ID, req.params.traceId);
    if (!detail) {
      return reply.code(404).send({ error: "Trace not found" });
    }
    return reply.code(200).send(detail);
  });

  return app;
}
