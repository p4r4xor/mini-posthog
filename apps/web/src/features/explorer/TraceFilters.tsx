/**
 * The explorer filter bar. A controlled form over the GET /traces query params
 * (time range + agentName/model/toolName/status/userId). It owns no fetching —
 * it lifts the assembled params up to the parent on apply/reset.
 */
import { useState } from "react";
import type { ListTracesParams } from "../../api-client/index.js";

interface TraceFiltersProps {
  onApply: (params: ListTracesParams) => void;
  loading: boolean;
}

/** Local form state — all strings so inputs stay controlled; trimmed on apply. */
interface FormState {
  from: string;
  to: string;
  agentName: string;
  model: string;
  toolName: string;
  status: string;
  userId: string;
}

const EMPTY: FormState = {
  from: "",
  to: "",
  agentName: "",
  model: "",
  toolName: "",
  status: "",
  userId: "",
};

/** Drop empty strings so we only send filters the user actually set. */
function toParams(form: FormState): ListTracesParams {
  const params: ListTracesParams = {};
  if (form.from) params.from = new Date(form.from).toISOString();
  if (form.to) params.to = new Date(form.to).toISOString();
  if (form.agentName) params.agentName = form.agentName.trim();
  if (form.model) params.model = form.model.trim();
  if (form.toolName) params.toolName = form.toolName.trim();
  if (form.status) params.status = form.status.trim();
  if (form.userId) params.userId = form.userId.trim();
  return params;
}

export function TraceFilters({ onApply, loading }: TraceFiltersProps): JSX.Element {
  const [form, setForm] = useState<FormState>(EMPTY);

  function set<K extends keyof FormState>(key: K, value: string): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <form
      className="filters"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(toParams(form));
      }}
    >
      <Field label="From">
        <input
          type="datetime-local"
          value={form.from}
          onChange={(e) => set("from", e.target.value)}
        />
      </Field>
      <Field label="To">
        <input
          type="datetime-local"
          value={form.to}
          onChange={(e) => set("to", e.target.value)}
        />
      </Field>
      <Field label="Agent">
        <input
          type="text"
          placeholder="agentName"
          value={form.agentName}
          onChange={(e) => set("agentName", e.target.value)}
        />
      </Field>
      <Field label="Model">
        <input
          type="text"
          placeholder="model"
          value={form.model}
          onChange={(e) => set("model", e.target.value)}
        />
      </Field>
      <Field label="Tool">
        <input
          type="text"
          placeholder="toolName"
          value={form.toolName}
          onChange={(e) => set("toolName", e.target.value)}
        />
      </Field>
      <Field label="Status">
        <select value={form.status} onChange={(e) => set("status", e.target.value)}>
          <option value="">any</option>
          <option value="success">success</option>
          <option value="failed">failed</option>
          <option value="running">running</option>
        </select>
      </Field>
      <Field label="User">
        <input
          type="text"
          placeholder="userId"
          value={form.userId}
          onChange={(e) => set("userId", e.target.value)}
        />
      </Field>

      <div className="filter-actions">
        <button className="btn primary" type="submit" disabled={loading}>
          {loading ? "Loading…" : "Apply"}
        </button>
        <button
          className="btn"
          type="button"
          disabled={loading}
          onClick={() => {
            setForm(EMPTY);
            onApply({});
          }}
        >
          Reset
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
