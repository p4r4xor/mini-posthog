/**
 * Frontend entrypoint (docs/architecture.md §13). Mounts the React app onto the
 * #root node declared in index.html and loads the global stylesheet.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
