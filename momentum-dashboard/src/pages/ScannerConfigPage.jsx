import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from 'react-router-dom';


function applyTheme(theme) {
  const t = String(theme || "dark").toLowerCase();
  document.documentElement.className = t === "light" ? "theme-light" : "theme-dark";
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function getByPath(obj, pathArr) {
  return pathArr.reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function setByPath(obj, pathArr, value) {
  const copy = deepClone(obj);
  let cur = copy;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const k = pathArr[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[pathArr[pathArr.length - 1]] = value;
  return copy;
}

function resolveRef(schema, ref) {
  // supports "#/$defs/xxx"
  if (!ref?.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let cur = schema;
  for (const p of parts) cur = cur?.[p];
  return cur || null;
}

function getEnumOptions(def) {
  // expects oneOf: [{ const, description }]
  if (!def?.oneOf) return null;
  return def.oneOf
    .filter((x) => Object.prototype.hasOwnProperty.call(x, "const"))
    .map((x) => ({
      value: x.const,
      label: x.description ?? String(x.const),
    }));
}

const styles = {
  page: {
    padding: 16,
    maxWidth: 1600,
    margin: "0 auto",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    flexWrap: "wrap",
  },
  title: { fontSize: 24, fontWeight: 800 },
  subtitle: { opacity: 0.8 },
  actions: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    position: "sticky",
    top: 10,
    alignSelf: "flex-start",
    background: "transparent",
  },
  grid: {
    display: "grid",
    gap: 14,
    marginTop: 14,
    gridTemplateColumns: "1fr",
  },
  card: {
    border: "1px solid #ddd",
    borderRadius: 12,
    padding: 16,
    background: "rgba(255,255,255,0.75)",
  },
  cardTitle: { fontSize: 18, fontWeight: 700, marginBottom: 10 },
};

// simple responsive grid (no CSS file needed)
function useGridColumns() {
  const [cols, setCols] = useState(1);

  useEffect(() => {
    const calc = () => {
      const w = window.innerWidth;
      if (w >= 1300) setCols(3);
      else if (w >= 900) setCols(2);
      else setCols(1);
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  return cols;
}


function Field({ schema, def, path, value, onChange }) {
  const title = def?.title || path.join(".");
  const desc = def?.description;

  // $ref
  if (def?.$ref) {
    const resolved = resolveRef(schema, def.$ref);
    if (!resolved) return null;
    return (
      <Field
        schema={schema}
        def={resolved}
        path={path}
        value={value}
        onChange={onChange}
      />
    );
  }

  // array (multi select)
  if (def?.type === "array") {
    const itemsDef = def.items?.$ref ? resolveRef(schema, def.items.$ref) : def.items;
    const options = getEnumOptions(itemsDef);

    if (options) {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          {desc ? <div style={{ opacity: 0.8, marginBottom: 6 }}>{desc}</div> : null}

          <select
            multiple
            value={selected}
            onChange={(e) => {
              const vals = Array.from(e.target.selectedOptions).map((o) => o.value);
              // enforce unique in UI as well
              const uniq = Array.from(new Set(vals));
              onChange(uniq);
            }}
            style={{ width: "100%", minHeight: 130 }}
          >
            {options.map((o) => (
              <option key={String(o.value)} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
            Hold Ctrl/⌘ to select multiple.
          </div>
        </div>
      );
    }
  }

  // enum string -> dropdown
  const options = getEnumOptions(def);
  if (options && (def.type === "string" || !def.type)) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        {desc ? <div style={{ opacity: 0.8, marginBottom: 6 }}>{desc}</div> : null}
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: "100%", padding: 8 }}
        >
          {options.map((o) => (
            <option key={String(o.value)} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // boolean
  if (def?.type === "boolean") {
    return (
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span style={{ fontWeight: 600 }}>{title}</span>
        </label>
        {desc ? <div style={{ opacity: 0.8, marginTop: 6 }}>{desc}</div> : null}
      </div>
    );
  }

  // number
  if (def?.type === "number" || def?.type === "integer") {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        {desc ? <div style={{ opacity: 0.8, marginBottom: 6 }}>{desc}</div> : null}
        <input
          type="number"
          value={value ?? ""}
          min={def.minimum ?? undefined}
          max={def.maximum ?? undefined}
          step={def.type === "integer" ? 1 : "any"}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === "" ? "" : Number(v));
          }}
          style={{ width: "95%", padding: 8 }}
        />
      </div>
    );
  }

  return null;
}

export default function ScannerConfigPage() {
  const [schema, setSchema] = useState(null);
  const [config, setConfig] = useState(null);
  const [original, setOriginal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const cols = useGridColumns();

  useEffect(() => {
    (async () => {
      const s = await fetch("/api/config/schema").then((r) => r.json());
      const c = await fetch("/api/config").then((r) => r.json());
      setSchema(s);
      setConfig(c);
      setOriginal(deepClone(c));
    })().catch((err) => setSaveResult({ ok: false, errors: [{ message: String(err) }] }));
  }, []);

  useEffect(() => {
    if (!config) return;
    applyTheme(config?.appsettings?.DefaultTheme);
  }, [config?.appsettings?.DefaultTheme]);

  const changes = useMemo(() => {
    if (!config || !original) return [];
    return diffObjects(original, config);
    }, [config, original]);

  const dirty = useMemo(() => {
    if (!config || !original) return false;
    return JSON.stringify(config) !== JSON.stringify(original);
  }, [config, original]);

  if (!schema || !config) {
    return <div style={{ padding: 16 }}>Loading config editor…</div>;
  }

  function diffObjects(before, after, path = "") {
    const changes = [];

    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

    // primitives / arrays: compare directly
    if (!isObj(before) || !isObj(after)) {
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ path: path || "(root)", before, after });
      }
      return changes;
    }

    // objects
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      changes.push(...diffObjects(before?.[k], after?.[k], p));
    }
    return changes;
  }
  
  const finvizDef = schema.properties?.finviz?.$ref
    ? resolveRef(schema, schema.properties.finviz.$ref)
    : schema.properties?.finviz;

  const scannerDef = schema.properties?.scanner?.$ref
    ? resolveRef(schema, schema.properties.scanner.$ref)
    : schema.properties?.scanner;

  const appDef = schema.properties?.appsettings?.$ref
    ? resolveRef(schema, schema.properties.appsettings.$ref)
    : schema.properties?.appsettings;

  const simulatorDef = schema.properties?.simulator?.$ref
    ? resolveRef(schema, schema.properties.simulator.$ref)
    : schema.properties?.simulator;

  async function onSave() {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      }).then((r) => r.json());

      setSaveResult(res);
      if (res.ok) setOriginal(deepClone(config));
    } catch (e) {
      setSaveResult({ ok: false, errors: [{ message: String(e) }] });
    } finally {
      setSaving(false);
    }
  }

function renderObjectBlock(blockTitle, blockPath, blockDef) {
  if (!blockDef?.properties) return null;

  return (
    <section style={styles.card}>
      <div style={styles.cardTitle}>{blockTitle}</div>

      {Object.entries(blockDef.properties).map(([key, def]) => {
        const path = [...blockPath, key];
        const value = getByPath(config, path);
        return (
          <Field
            key={path.join(".")}
            schema={schema}
            def={def}
            path={path}
            value={value}
            onChange={(val) => setConfig((prev) => setByPath(prev, path, val))}
          />
        );
      })}
    </section>
  );
}



function BackButtonComponent() {
  const navigate = useNavigate();

  const handleBack = () => {
    navigate(-1);
  };

  return (
    <button onClick={handleBack}>
      Go Back
    </button>
  );
}
  

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <div>
          <div style={styles.title}>Scanner Config Editor</div>
          <div style={styles.subtitle}>Edit values and click Save once when you’re ready.</div>
        </div>

        <div style={styles.actions}>
          <button
            disabled={!dirty || saving}
            onClick={onSave}
            style={{ padding: "10px 14px" }}
          >
            {saving ? "Saving…" : "Save"}
          </button>

          <button
            disabled={!dirty || saving}
            onClick={() => setConfig(deepClone(original))}
            style={{ padding: "10px 14px" }}
          >
            Reset
          </button>

          <BackButtonComponent />
        </div>
      </div>


      <div style={{ marginTop: 14, marginBottom: 14 }}>
        <strong>Status:</strong>{" "}
        {dirty ? "Unsaved changes" : "Saved"}
      </div>

      {dirty ? (
        <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12, marginTop: 14, marginBottom: 16 }}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Changes (pending save)</div>
          {changes.length === 0 ? (
            <div style={{ opacity: 0.8 }}>No differences detected.</div>
          ) : (
            <div style={{ maxHeight: 220, overflow: "auto" }}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {changes.map((c, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>
                    <code>{c.path}</code>{" "}
                    <span style={{ opacity: 0.8 }}>from</span>{" "}
                    <code>{JSON.stringify(c.before)}</code>{" "}
                    <span style={{ opacity: 0.8 }}>to</span>{" "}
                    <code>{JSON.stringify(c.after)}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}



      {saveResult && !saveResult.ok ? (
        <div style={{ background: "#fff3f3", border: "1px solid #f1b5b5", padding: 12, borderRadius: 10, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Save failed (schema validation)</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {(saveResult.errors || []).map((e, i) => (
              <li key={i}>
                <code>{e.path || "(root)"}</code>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

    <div
      style={{
        ...styles.grid,
        gridTemplateColumns: cols === 3 ? "1fr 1fr 1fr" : cols === 2 ? "1fr 1fr" : "1fr",
      }}
    >
      {renderObjectBlock("Finviz Settings", ["finviz"], finvizDef)}
      {renderObjectBlock("Scanner Settings", ["scanner"], scannerDef)}
      {renderObjectBlock("App Settings", ["appsettings"], appDef)}
      {renderObjectBlock("Simulator Settings", ["simulator"], simulatorDef)}
    </div>

    </div>
  );
}
