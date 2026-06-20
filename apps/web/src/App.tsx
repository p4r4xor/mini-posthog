/**
 * App shell: a top-level tab nav switching between the Query and Explorer views.
 * State is intentionally tiny (which tab is active) — each feature owns its own
 * data fetching and local state.
 */
import { useState } from "react";
import { QueryView } from "./features/query/QueryView.js";
import { ExplorerView } from "./features/explorer/ExplorerView.js";

type Tab = "query" | "explorer";

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("query");

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◢◣</span>
          <span className="brand-name">Agent Trace Analytics</span>
        </div>
        <nav className="tabs">
          <button
            type="button"
            className={`tab${tab === "query" ? " active" : ""}`}
            onClick={() => setTab("query")}
          >
            Query
          </button>
          <button
            type="button"
            className={`tab${tab === "explorer" ? " active" : ""}`}
            onClick={() => setTab("explorer")}
          >
            Explorer
          </button>
        </nav>
      </header>

      <main className="app-main">
        {tab === "query" ? <QueryView /> : <ExplorerView />}
      </main>
    </div>
  );
}
