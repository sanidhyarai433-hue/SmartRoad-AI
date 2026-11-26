"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const API = (process.env.NEXT_PUBLIC_BACKEND_URL || "https://smartroad-ai-6qsx.onrender.com").replace(/\/+$/, "");
const MUNICIPALITIES = ["Mysuru City Corporation","Mangaluru City Corporation","BBMP Bengaluru","Hubballi-Dharwad Municipal Corporation","Belagavi City Corporation","Local Gram Panchayat","Other / Specify manually"];

const DEPARTMENTS = [
  "Public Works Department (PWD)",
  "National Highways Authority of India (NHAI)",
  "State Highways Division",
  "Municipal Engineering Department",
  "Gram Panchayat / Local Authority",
  "Traffic & Transport Department",
];

const ui = {
  page: { minHeight: "100%", background: "#070d1b", color: "#e5edf8", padding: "28px clamp(14px, 3vw, 34px)", fontFamily: "Arial, sans-serif" },
  card: { background: "linear-gradient(145deg,#101b30,#0b1425)", border: "1px solid #24334c", borderRadius: 16, padding: 18 },
  muted: { color: "#8da0ba" },
  input: { width: "100%", boxSizing: "border-box", background: "#091326", color: "#e5edf8", border: "1px solid #30425f", borderRadius: 8, padding: "10px 11px", outline: "none" },
  label: { display: "block", color: "#a9bad1", fontSize: 12, marginBottom: 6 },
  button: { border: 0, borderRadius: 8, padding: "10px 14px", background: "#2563eb", color: "white", fontWeight: 700, cursor: "pointer" },
};

async function request(path, options = {}) {
  const response = await fetch(API + path, { ...options, headers: { ...(options.headers || {}) }, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const detail = data.detail || data.message || response.statusText || "Request failed";
    throw new Error(`${detail} (HTTP ${response.status}: ${path})`);
  }
  return data;
}

function bandColor(band) {
  return band === "Critical" ? "#fb7185" : band === "High" ? "#fb923c" : band === "Moderate" ? "#facc15" : "#4ade80";
}

function Panel({ title, children, hint }) {
  return <section style={{ ...ui.card, marginBottom: 16 }}>
    <h3 style={{ margin: "0 0 5px", fontSize: 17 }}>{title}</h3>
    {hint && <p style={{ ...ui.muted, margin: "0 0 14px", fontSize: 12 }}>{hint}</p>}
    {children}
  </section>;
}

export default function RoadPriorityPage() {
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [forms, setForms] = useState({});
  const [expanded, setExpanded] = useState("");
  const [tab, setTab] = useState("queue");
  const [intelligence, setIntelligence] = useState(null);
  const [departmentBusy, setDepartmentBusy] = useState("");
  const [municipalAssignments, setMunicipalAssignments] = useState({});
  const [departmentRequestsBusy, setDepartmentRequestsBusy] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await request("/admin/priority/incidents");
      setIncidents(result.data || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== "intelligence") return;
    request("/admin/maintenance/intelligence").then(result => setIntelligence(result.data || null)).catch(e => setError(e.message));
  }, [tab]);

  const stats = useMemo(() => ({
    total: incidents.length,
    critical: incidents.filter(x => x.priority_band === "Critical").length,
    referrals: incidents.filter(x => (x.referred_to || x.department_referral)).length,
    inspections: incidents.filter(x => x.inspection?.status === "Requested" || x.status === "Inspection Requested").length,
    pending: incidents.filter(x => !["Completed", "Closed", "False Image/Rejected"].includes(x.status)).length,
  }), [incidents]);

  useEffect(() => {
    setMunicipalAssignments(prev => {
      const next = { ...prev };
      incidents.forEach(item => {
        if (!next[item.incident_id]) next[item.incident_id] = {
          municipality: item.municipality && item.municipality !== "Unassigned" ? item.municipality : "",
          department: item.department && item.department !== "Unassigned" ? item.department : "",
          office: item.authority && item.authority !== "Unassigned" ? item.authority : ""
        };
      });
      return next;
    });
  }, [incidents]);

  const updateMunicipalAssignment = (id, field, val) => {
    setMunicipalAssignments(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: val } }));
  };

  const departmentGroups = useMemo(() => {
    const groups = new Map();
    incidents.forEach(item => {
      if (!item.admin_verified) return;
      const a = municipalAssignments[item.incident_id] || {};
      const municipality = String(a.municipality || "").trim();
      const department = String(a.department || "").trim();
      const office = String(a.office || "").trim();
      if (!municipality || !department || municipality === "Other / Specify manually") return;
      const key = [municipality, department, office].join("|").toLowerCase();
      if (!groups.has(key)) groups.set(key, { key, municipality, department, office, incidents: [] });
      groups.get(key).incidents.push(item);
    });
    return [...groups.values()].map(g => ({ ...g, incidents: g.incidents.sort((a,b) => (b.priority_score || 0) - (a.priority_score || 0)) }));
  }, [incidents, municipalAssignments]);

  async function saveMunicipalAssignment(incident) {
    const assignment = municipalAssignments[incident.incident_id] || {};
    const municipality = String(assignment.municipality || "").trim();
    const department = String(assignment.department || "").trim();
    const office = String(assignment.office || "").trim();
    if (!municipality || !department) {
      setError("Select both a municipality/local body and a responsible department before saving.");
      return;
    }
    if (municipality === "Other / Specify manually" && !office) {
      setError("Enter the responsible office name when selecting Other / Specify manually.");
      return;
    }
    await perform(incident.incident_id, "triage", {
      municipality,
      department,
      authority: office || municipality
    }, `Routing saved for ${incident.incident_id}. It is now stored in the backend.`);
  }

  async function sendDepartmentRequest(group) {
    setDepartmentRequestsBusy(group.key); setError(""); setNotice("");
    try {
      const result = await request("/admin/department-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incident_ids: group.incidents.map(item => item.incident_id),
          note: `Consolidated request for ${group.municipality} — ${group.department}.`
        })
      });
      setNotice(`Department request ${result.data?.request_id || ""} was saved in SmartRoad AI. This is an internal referral record, not an official government transmission.`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setDepartmentRequestsBusy("");
    }
  }
  const value = (id, key, fallback = "") => forms[id]?.[key] ?? fallback;
  const setValue = (id, key, val) => setForms(old => ({ ...old, [id]: { ...old[id], [key]: val } }));

  async function perform(id, action, payload, successMessage) {
    setSaving(id); setError(""); setNotice("");
    try {
      await request(`/admin/priority/incidents/${id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      setNotice(successMessage);
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(""); }
  }

  async function uploadRepairEvidence(incident, file) {
    if (!file) return;
    const body = new FormData(); body.append("file", file);
    setSaving(incident.incident_id); setError(""); setNotice("");
    try {
      await request(`/admin/priority/incidents/${incident.incident_id}/repair-evidence`, { method: "POST", body });
      setNotice("Repair evidence uploaded. Review it before closing the complaint.");
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(""); }
  }

  const exportReport = () => {
    const rows = [
      ["Incident ID","Location","Priority","Score","Severity","Reports","Assigned Municipality","Assigned Department","Status"],
      ...incidents.map(x => [x.incident_id, x.location, x.priority_band, x.priority_score, x.severity, x.supporting_reports, municipalAssignments[x.incident_id]?.municipality || "", municipalAssignments[x.incident_id]?.department || "", x.status || ""])
    ];
    const csv = rows.map(row => row.map(v => '"' + String(v ?? "").replaceAll('"','""') + '"').join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "smartroad-maintenance-intelligence.csv"; a.click(); URL.revokeObjectURL(url);
  };

  return <main style={ui.page}>
    <div style={{ maxWidth: 1440, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
        <div>
          <div style={{ color: "#60a5fa", fontSize: 11, fontWeight: 800, letterSpacing: 2 }}>SMARTROAD AI · GOVERNMENT ACTION DESK</div>
          <h1 style={{ fontSize: "clamp(25px,4vw,36px)", margin: "7px 0" }}>Priority & Municipality Routing</h1>
          <p style={{ ...ui.muted, margin: 0, fontSize: 13 }}>Review priority-ranked complaints and assign each road issue to its responsible municipality or department.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a href="/admin" style={{ color: "#b8c8df", textDecoration: "none", border: "1px solid #30425f", borderRadius: 8, padding: "10px 13px" }}>← Dashboard</a>
          <button style={ui.button} onClick={load}>↻ Refresh</button>
        </div>
      </header>

      {error && <div role="alert" style={{ background: "#421b2a", border: "1px solid #9f3653", color: "#fecdd3", borderRadius: 9, padding: 12, marginBottom: 12 }}>{error}</div>}
      {notice && <div role="status" style={{ background: "#123528", border: "1px solid #24734d", color: "#bbf7d0", borderRadius: 9, padding: 12, marginBottom: 12 }}>{notice}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 10, marginBottom: 18 }}>
        {[["Active incidents",stats.total],["Critical priority",stats.critical],["Municipality assigned",Object.values(municipalAssignments).filter(x => x.municipality).length],["Inspections requested",stats.inspections],["Open issues",stats.pending]].map(([label,n]) =>
          <div key={label} style={ui.card}><div style={{ ...ui.muted, fontSize: 11 }}>{label}</div><div style={{ fontSize: 29, fontWeight: 800, marginTop: 7 }}>{n}</div></div>)}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {[["queue","Priority ranking"],["departments","Department requests"],["intelligence","Maintenance intelligence"]].map(([id,label]) =>
          <button key={id} onClick={() => setTab(id)} style={{ ...ui.button, background: tab === id ? "#2563eb" : "#17243a", border: "1px solid #30425f" }}>{label}</button>)}
        <button onClick={exportReport} style={{ ...ui.button, marginLeft: "auto", background: "#14532d" }}>Export CSV report ↓</button>
      </div>

      {tab === "departments" ? <div style={{ display: "grid", gap: 12 }}>
        <Panel title="Municipality-wise consolidated requests" hint="Only visually verified incidents with saved municipality and department assignments are grouped here. Requests are persisted in the SmartRoad AI backend.">
          {departmentGroups.length === 0 ? <p style={ui.muted}>No visually verified incidents have been assigned to a municipality yet. Open Priority ranking and choose a municipality and department in the Assigned Municipality column.</p> : departmentGroups.map(group => {
            const requestRecord = group.incidents.map(item => item.department_request).find(Boolean);
            const pending = requestRecord ? [] : group.incidents;
            return <div key={group.key} style={{ border: "1px solid #30425f", borderRadius: 12, padding: 14, marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <div><div style={{ fontWeight: 800, fontSize: 16 }}>{group.municipality}</div><div style={{ ...ui.muted, fontSize: 12 }}>{group.department} · {group.incidents.length} incident(s) · {group.incidents.reduce((n,x) => n + (x.supporting_reports || 0),0)} citizen reports</div></div>
                <button disabled={!pending.length || departmentRequestsBusy === group.key} style={{ ...ui.button, background: pending.length ? "#166534" : "#334155", opacity: departmentRequestsBusy === group.key ? 0.7 : 1 }} onClick={() => sendDepartmentRequest(group)}>{departmentRequestsBusy === group.key ? "Saving request…" : pending.length ? `Create department request (${pending.length})` : "Request recorded"}</button>
              </div>
              <div style={{ marginTop: 12, display: "grid", gap: 7 }}>{group.incidents.map((item,index) => <div key={item.incident_id} style={{ display: "grid", gridTemplateColumns: "34px 1fr auto", gap: 9, alignItems: "center", background: "#091426", borderRadius: 8, padding: 10 }}><strong style={{ color: bandColor(item.priority_band) }}>#{index+1}</strong><div><div style={{ fontSize: 12, fontWeight: 700 }}>{item.location}</div><div style={{ ...ui.muted, fontSize: 11 }}>{item.incident_id} · {item.supporting_reports} report(s) · {item.priority_band} · score {item.priority_score}</div></div><div style={{ textAlign: "right", fontSize: 11, color: requestRecord ? "#86efac" : "#fbbf24" }}>{requestRecord ? `Saved · ${requestRecord.request_id}` : "Ready to group"}</div></div>)}</div>
              {requestRecord && <div style={{ color: "#86efac", fontSize: 11, marginTop: 9 }}>Backend record: {requestRecord.request_id} · {requestRecord.created_at} · {requestRecord.status}</div>}
            </div>;
          })}
        </Panel>
        <p style={{ ...ui.muted, fontSize: 11 }}>Requests are stored as internal SmartRoad AI referral records for tracking. They are not automatically transmitted to an official municipal/government portal.</p>
      </div> : tab === "intelligence" ? <div>
        {!intelligence ? <p style={ui.muted}>Loading historical maintenance intelligence…</p> : <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(155px,1fr))", gap: 10, marginBottom: 12 }}>
            {[[ "All submitted complaints", intelligence.total_complaints ],[ "Critical / major complaints", intelligence.critical_complaints ],[ "Pending referrals", intelligence.pending_referrals ],[ "Inspections completed", intelligence.inspections_completed ],[ "Repairs verified", intelligence.repairs_verified ]].map(([label,n]) => <div key={label} style={ui.card}><div style={{ ...ui.muted, fontSize: 11 }}>{label}</div><div style={{ fontSize: 27, fontWeight: 800, marginTop: 7 }}>{n}</div></div>)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12 }}>
            <Panel title="Most affected locations">{(intelligence.areas_by_complaints || []).map((x,i) => <div key={i} style={{ display:"flex",justifyContent:"space-between",gap:8,borderTop:"1px solid #263852",padding:"8px 0",fontSize:12 }}><span>{x.location}</span><strong>{x.reports}</strong></div>)}</Panel>
            <Panel title="Repeated damage locations" hint="Locations with more than one submitted complaint.">{(intelligence.repeated_damage_locations || []).length ? intelligence.repeated_damage_locations.map((x,i) => <div key={i} style={{ display:"flex",justifyContent:"space-between",gap:8,borderTop:"1px solid #263852",padding:"8px 0",fontSize:12 }}><span>{x.location}</span><strong>{x.reports} reports</strong></div>) : <span style={ui.muted}>No repeated locations recorded yet.</span>}</Panel>
          </div>
        </>}
        <Panel title="Reporting note" hint="Historical summary includes completed complaints.">{<p style={{ fontSize: 12, lineHeight: 1.7, ...ui.muted }}>Use this intelligence report to identify areas needing preventive maintenance, repeated road damage, critical safety risks, pending department referrals, and verified repairs. Export the queue CSV for review. Figures are based on submitted reports and are not approved government budgets or certified engineering assessments.</p>}</Panel>
      </div> : loading ? <p style={ui.muted}>Loading priority queue…</p> : incidents.length === 0 ? <Panel title="No active incidents">Submitted road-damage complaints with AI detections will appear here after they are received by the backend.</Panel> :
        <div style={{ display: "grid", gap: 12 }}>
          {incidents.map(incident => {
            const id = incident.incident_id;
            const form = forms[id] || {};
            const open = expanded === id;
            const rec = incident.maintenance_recommendation || {};
            return <article key={id} style={{ ...ui.card, borderColor: incident.priority_band === "Critical" ? "#7f344b" : "#24334c" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 220, flex: 1 }}>
                  <div style={{ ...ui.muted, fontSize: 10, letterSpacing: 1 }}>RANK #{incident.rank} · {id} · {incident.supporting_reports} CITIZEN REPORT(S)</div>
                  <h2 style={{ fontSize: 18, margin: "6px 0" }}>{incident.location}</h2>
                  <div style={{ ...ui.muted, fontSize: 12 }}>{incident.description || "No citizen description"} · {incident.severity} damage</div>
                  <div style={{ marginTop: 8, fontSize: 11, color: "#9fb2cb" }}>Department: {incident.department || "Not assigned"} · Status: {incident.status || "In Review"}</div>
                </div>
                <div style={{ minWidth: 110, textAlign: "right" }}>
                  <div style={{ color: bandColor(incident.priority_band), fontWeight: 800 }}>{incident.priority_band}</div>
                  <div style={{ fontSize: 29, fontWeight: 800 }}>{incident.priority_score}<span style={{ fontSize: 12, ...ui.muted }}>/100</span></div>
                  <div style={{ fontSize: 10, ...ui.muted }}>Priority score</div>
                </div>
              </div>
              <div style={{ height: 6, background: "#1e293b", borderRadius: 99, overflow: "hidden", margin: "13px 0" }}><div style={{ width: `${incident.priority_score || 0}%`, height: "100%", background: bandColor(incident.priority_band) }} /></div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button style={ui.button} onClick={() => setExpanded(open ? "" : id)}>{open ? "Hide action panel" : "Review complaint →"}</button>
                {incident.admin_verified ? <span style={{ color: "#86efac", fontSize: 11, padding: 10 }}>✓ Visually verified</span> : <button disabled={saving === id} style={{ ...ui.button, background: "#166534" }} onClick={() => perform(id,"verify",{ note:"AI-generated image and detection evidence visually reviewed by admin." },`Complaint ${id} visually verified.`)}>Verify complaint</button>}
                <div style={{ background: "#091426", border: "1px solid #30425f", borderRadius: 10, padding: 11, minWidth: 250 }}>
                  <div style={{ color: "#93c5fd", fontSize: 10, fontWeight: 800, letterSpacing: 1, marginBottom: 7 }}>ASSIGNED MUNICIPALITY / DEPARTMENT</div>
                  <select aria-label="Assigned municipality" style={{ ...ui.input, marginBottom: 7 }} value={municipalAssignments[id]?.municipality || ""} onChange={e => updateMunicipalAssignment(id,"municipality",e.target.value)}>
                    <option value="">Select municipality / local body</option>
                    {MUNICIPALITIES.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <select aria-label="Assigned department" style={ui.input} value={municipalAssignments[id]?.department || ""} onChange={e => updateMunicipalAssignment(id,"department",e.target.value)}>
                    <option value="">Select responsible department</option>
                    {DEPARTMENTS.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <input aria-label="Office name" style={{ ...ui.input, marginTop: 7 }} placeholder="Office / zone / ward (optional)" value={municipalAssignments[id]?.office || ""} onChange={e => updateMunicipalAssignment(id,"office",e.target.value)} />
                  <div style={{ color: municipalAssignments[id]?.municipality && municipalAssignments[id]?.department ? "#86efac" : "#fbbf24", fontSize: 10, marginTop: 7 }}>{municipalAssignments[id]?.municipality && municipalAssignments[id]?.department ? "Authority selected · grouped in Department Requests" : "Awaiting municipality assignment"}</div>
                  <button disabled={saving === id} style={{ ...ui.button, width: "100%", marginTop: 9, background: "#0f766e", opacity: saving === id ? 0.65 : 1 }} onClick={() => saveMunicipalAssignment(incident)}>{saving === id ? "Saving routing…" : "Save municipality routing"}</button>
                </div>
                <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                  {incident.lat != null && incident.lng != null && <a href={`https://www.google.com/maps?q=${incident.lat},${incident.lng}`} target="_blank" rel="noreferrer" style={{ color: "#93c5fd", fontSize: 12 }}>Open location map ↗</a>}
                </div>
              </div>

              {open && <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
                <Panel title="Municipality routing" hint="Choose the municipality and department in the Assigned Municipality / Department column on the priority card.">
                  <p style={{ ...ui.muted, fontSize: 12, margin: 0 }}>Choose the authority and save it. The backend updates the incident records and the saved assignment is used to build Department Requests.</p>
                </Panel>

                <Panel title="2 · Physical inspection" hint="Request an authorized field officer to verify the road condition before maintenance decisions.">
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10 }}>
                    <div><label style={ui.label}>Field officer / team</label><input style={ui.input} value={value(id,"officer","")} onChange={e => setValue(id,"officer",e.target.value)} placeholder="Officer or inspection team" /></div>
                    <div><label style={ui.label}>Inspection instructions</label><input style={ui.input} value={value(id,"inspection_note","")} onChange={e => setValue(id,"inspection_note",e.target.value)} placeholder="What should be checked?" /></div>
                  </div>
                  <button disabled={saving === id} style={{ ...ui.button, marginTop: 10, background: "#6d28d9" }} onClick={() => perform(id,"inspection",{ officer:value(id,"officer","Field Inspection Team"), note:value(id,"inspection_note","Verify road damage and safety risk") },`Inspection request created for ${id}.`)}>Request field inspection</button>
                  {incident.inspection && <div style={{ marginTop: 10, fontSize: 12, color: "#c4b5fd" }}>Inspection: {incident.inspection.status} · {incident.inspection.officer || "Officer not assigned"}<p style={{ ...ui.muted, margin: "4px 0" }}>{incident.inspection.observation || incident.inspection.note || "Awaiting field observations."}</p></div>}
                  <div style={{ marginTop: 10 }}><label style={ui.label}>Record field observations (admin-entered for prototype)</label><textarea style={{ ...ui.input, minHeight: 72, resize: "vertical" }} value={value(id,"observation","")} onChange={e => setValue(id,"observation",e.target.value)} placeholder="Observed depth, dimensions, traffic risk, drainage, and recommended action…" /><button disabled={saving === id || !value(id,"observation","").trim()} style={{ ...ui.button, marginTop: 8, background: "#5b21b6" }} onClick={() => perform(id,"inspection-result",{ observation:value(id,"observation","") },`Inspection observations saved for ${id}.`)}>Save inspection result</button></div>
                </Panel>

                <Panel title="3 · Maintenance recommendation" hint="Preliminary guidance based on AI severity. It is not an engineering certification, tender, or approved budget.">
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 8 }}>
                    {[["Recommended action",rec.action || (incident.severity === "Major" ? "Technical inspection and detailed repair assessment" : incident.severity === "Moderate" ? "Detailed inspection and patch repair assessment" : "Routine patch repair assessment")],["Planning priority",incident.priority_band || "Pending"],["Estimate status","Preliminary — not an approved cost"]].map(([k,v]) => <div key={k} style={{ background: "#091426", borderRadius: 9, padding: 11 }}><div style={{ ...ui.muted, fontSize: 10 }}>{k}</div><div style={{ fontSize: 12, marginTop: 5 }}>{v}</div></div>)}
                  </div>
                </Panel>

                <Panel title="4 · Repair evidence & closure" hint="When the responsible authority reports completion, attach an after-repair photograph. An admin must review it before closing the issue.">
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
                    <div style={{ flex: 1, minWidth: 220 }}><label style={ui.label}>Upload after-repair photograph</label><input type="file" accept="image/png,image/jpeg,image/webp" style={{ ...ui.input, padding: 7 }} onChange={e => uploadRepairEvidence(incident,e.target.files?.[0])} /></div>
                    <button disabled={saving === id} style={{ ...ui.button, background: "#166534" }} onClick={() => perform(id,"close",{ note:value(id,"closure_note","Evidence reviewed by admin") },`Incident ${id} closed after admin verification.`)}>Verify evidence & close</button>
                    <button disabled={saving === id} style={{ ...ui.button, background: "#9a3412" }} onClick={() => perform(id,"reopen",{ note:value(id,"closure_note","Further work required") },`Incident ${id} reopened.`)}>Reopen / request further action</button>
                  </div>
                  <label style={{ ...ui.label, marginTop: 10 }}>Verification note</label><input style={ui.input} value={value(id,"closure_note","")} onChange={e => setValue(id,"closure_note",e.target.value)} placeholder="Record why the repair is accepted or rejected" />
                  {(incident.repair_evidence || []).map((e,i) => <div key={i} style={{ marginTop: 8 }}><a href={API + e.url} target="_blank" rel="noreferrer" style={{ color: "#93c5fd", fontSize: 12 }}>View uploaded evidence {i+1} ↗</a></div>)}
                </Panel>
              </div>}
            </article>;
          })}
        </div>}
      <p style={{ ...ui.muted, fontSize: 11, marginTop: 18, lineHeight: 1.6 }}>SmartRoad AI is a decision-support prototype. Department referrals are recorded in this system for demonstration and are not official submissions unless an authorized integration is configured. Field observations and closure decisions require human verification.</p>
    </div>
  </main>;
}
