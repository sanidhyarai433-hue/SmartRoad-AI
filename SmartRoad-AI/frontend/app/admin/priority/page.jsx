"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const API = (process.env.NEXT_PUBLIC_BACKEND_URL || "").replace(/\/+$/, "");
const styles = {
  page: { minHeight: "100vh", background: "#070d1b", color: "#e5edf8", padding: "28px clamp(16px, 4vw, 48px)", fontFamily: "Arial, sans-serif" },
  shell: { maxWidth: 1440, margin: "0 auto" },
  muted: { color: "#8da0ba" },
  card: { background: "linear-gradient(145deg, #101b30, #0b1425)", border: "1px solid #24334c", borderRadius: 16, padding: 20 },
  button: { border: 0, borderRadius: 9, padding: "10px 15px", background: "#2563eb", color: "white", fontWeight: 700, cursor: "pointer" },
  input: { width: "100%", boxSizing: "border-box", background: "#091326", color: "#e5edf8", border: "1px solid #30425f", borderRadius: 8, padding: "11px 12px", outline: "none" },
  label: { display: "block", color: "#a9bad1", fontSize: 12, marginBottom: 6 },
};

async function request(path, options = {}) {
  if (!API) throw new Error("NEXT_PUBLIC_BACKEND_URL is not configured.");
  const response = await fetch(API + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.detail || data.message || "Request failed");
  return data;
}

function priorityColor(band) {
  return band === "Critical" ? "#fb7185" : band === "High" ? "#fb923c" : band === "Moderate" ? "#facc15" : "#4ade80";
}

export default function RoadPriorityPage() {
  const [incidents, setIncidents] = useState([]);
  const [contractors, setContractors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", company: "", phone: "", email: "", password: "", service_area: "", specialization: "Road repair" });
  const [credentialPasswords, setCredentialPasswords] = useState({});
  const [assignments, setAssignments] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [incidentData, contractorData] = await Promise.all([
        request("/admin/priority/incidents"),
        request("/admin/contractors"),
      ]);
      setIncidents(incidentData.data || []);
      setContractors(contractorData.data || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => ({
    total: incidents.length,
    critical: incidents.filter(x => x.priority_band === "Critical").length,
    unassigned: incidents.filter(x => !x.assignment).length,
    reports: incidents.reduce((sum, x) => sum + (x.supporting_reports || 0), 0),
  }), [incidents]);

  function updateForm(key, value) { setForm(current => ({ ...current, [key]: value })); }

  async function addContractor(event) {
    event.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await request("/admin/contractors", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", company: "", phone: "", email: "", password: "", service_area: "", specialization: "Road repair" });
      setNotice("Contractor registered successfully.");
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function assign(incident) {
    const selection = assignments[incident.incident_id] || {};
    if (!selection.contractor_id) { setError("Choose a contractor before assigning this repair job."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      await request(`/admin/priority/incidents/${incident.incident_id}/assign`, {
        method: "POST",
        body: JSON.stringify({ contractor_id: selection.contractor_id, deadline: selection.deadline || null, work_order: selection.work_order || "", notes: selection.notes || "" }),
      });
      setNotice(`Repair job ${incident.incident_id} assigned.`);
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function saveContractorPassword(contractor) {
    const password = credentialPasswords[contractor.contractor_id] || "";
    if (password.length < 8) { setError("Portal password must contain at least 8 characters."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      await request(`/admin/contractors/${contractor.contractor_id}/credentials`, { method: "POST", body: JSON.stringify({ password }) });
      setCredentialPasswords(v => ({ ...v, [contractor.contractor_id]: "" }));
      setNotice(`Portal access configured for ${contractor.name}.`);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function verifyRepair(incident, approved) {
    const note = window.prompt(approved ? "Verification note (optional):" : "Explain what needs to be corrected:");
    if (note === null) return;
    if (!approved && !note.trim()) { setError("A rework instruction is required."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      await request(`/admin/priority/incidents/${incident.incident_id}/verify`, { method: "POST", body: JSON.stringify({ approved, note }) });
      setNotice(approved ? "Repair verified and marked completed." : "Rework requested from contractor.");
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function unassign(incident) {
    if (!window.confirm("Remove this contractor assignment?")) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await request(`/admin/priority/incidents/${incident.incident_id}/unassign`, { method: "POST" });
      setNotice("Contractor assignment removed.");
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 26 }}>
          <div>
            <div style={{ color: "#60a5fa", fontSize: 11, fontWeight: 800, letterSpacing: 2 }}>ROADGUARD AI · OPERATIONS</div>
            <h1 style={{ fontSize: "clamp(25px, 4vw, 38px)", margin: "8px 0" }}>Road Priority & Contractor Desk</h1>
            <p style={{ ...styles.muted, margin: 0 }}>Group nearby reports, rank repair urgency, and assign one contractor to each master incident.</p>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a href="/admin" style={{ color: "#b8c8df", textDecoration: "none", border: "1px solid #30425f", borderRadius: 9, padding: "10px 14px" }}>← Admin dashboard</a>
            <button style={styles.button} onClick={load}>↻ Refresh queue</button>
          </div>
        </header>

        {error && <div role="alert" style={{ background: "#421b2a", border: "1px solid #9f3653", color: "#fecdd3", borderRadius: 10, padding: 12, marginBottom: 14 }}>{error}</div>}
        {notice && <div role="status" style={{ background: "#123528", border: "1px solid #24734d", color: "#bbf7d0", borderRadius: 10, padding: 12, marginBottom: 14 }}>{notice}</div>}

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 22 }}>
          {[
            ["Active master incidents", stats.total],
            ["Critical priority", stats.critical],
            ["Awaiting contractor", stats.unassigned],
            ["Citizen reports grouped", stats.reports],
          ].map(([label, value]) => <div key={label} style={styles.card}><div style={{ ...styles.muted, fontSize: 12 }}>{label}</div><div style={{ fontSize: 30, fontWeight: 800, marginTop: 8 }}>{value}</div></div>)}
        </section>

        <section style={{ ...styles.card, marginBottom: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
            <div><h2 style={{ margin: "0 0 5px", fontSize: 20 }}>Ranked repair queue</h2><p style={{ ...styles.muted, margin: 0, fontSize: 13 }}>Nearby reports within 35 metres are grouped as one incident. Citizen submissions remain individually traceable.</p></div>
            <span style={{ color: "#93c5fd", fontSize: 12 }}>Highest score = repair first</span>
          </div>
          {loading ? <p style={styles.muted}>Loading priority queue…</p> : incidents.length === 0 ? <p style={styles.muted}>No active detected road issues with reports available yet. Upload a report with GPS coordinates and detections to populate this queue.</p> : (
            <div style={{ display: "grid", gap: 13 }}>
              {incidents.map(incident => (
                <article key={incident.incident_id} style={{ background: "#091426", border: "1px solid #263852", borderRadius: 13, padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ color: "#8da0ba", fontSize: 11, letterSpacing: 1 }}>RANK #{incident.rank} · {incident.incident_id}</div>
                      <h3 style={{ margin: "6px 0", fontSize: 18 }}>{incident.location}</h3>
                      <div style={styles.muted}>{incident.description || "No additional description"} · {incident.supporting_reports} supporting report(s) · {incident.severity} damage</div>
                    </div>
                    <div style={{ textAlign: "right", minWidth: 100 }}>
                      <div style={{ color: priorityColor(incident.priority_band), fontWeight: 800, fontSize: 13 }}>{incident.priority_band}</div>
                      <div style={{ fontSize: 28, fontWeight: 800 }}>{incident.priority_score}<span style={{ fontSize: 12, color: "#8da0ba" }}>/100</span></div>
                    </div>
                  </div>
                  <div style={{ height: 6, background: "#1e293b", borderRadius: 99, overflow: "hidden", margin: "14px 0" }}><div style={{ width: `${incident.priority_score}%`, height: "100%", background: priorityColor(incident.priority_band) }} /></div>
                  <details style={{ color: "#a9bad1", fontSize: 12, marginBottom: 13 }}>
                    <summary style={{ cursor: "pointer" }}>Why is this ranked #{incident.rank}?</summary>
                    <ul>{(incident.priority_reasons || []).map((reason, i) => <li key={i} style={{ marginTop: 5 }}>{reason}</li>)}</ul>
                    <p>Linked report IDs: {(incident.report_ids || []).join(", ")}</p>
                  </details>
                  {incident.status === "Site Verification" && (
                    <div style={{ background: "#211b3a", border: "1px solid #5b4a91", borderRadius: 10, padding: 13, marginBottom: 12 }}>
                      <strong style={{ color: "#c4b5fd" }}>Repair submitted — municipal verification required</strong>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                        {(incident.contractor_work?.evidence || []).map((item, index) => <a key={index} href={API + item.url} target="_blank" rel="noreferrer"><img src={API + item.url} alt={item.type + " repair evidence"} style={{ width: 100, height: 76, objectFit: "cover", borderRadius: 7 }} /><div style={{ color: "#c4b5fd", fontSize: 11, textAlign: "center" }}>{item.type} photo</div></a>)}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                        <button disabled={saving} onClick={() => verifyRepair(incident, true)} style={{ ...styles.button, background: "#166534" }}>Approve repair</button>
                        <button disabled={saving} onClick={() => verifyRepair(incident, false)} style={{ ...styles.button, background: "#9a3412" }}>Request rework</button>
                      </div>
                    </div>
                  )}
                  {incident.assignment ? (
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center", background: "#102b28", borderRadius: 9, padding: 12 }}>
                      <div><strong style={{ color: "#86efac" }}>Assigned to {incident.assignment.contractor_name}</strong><div style={{ ...styles.muted, fontSize: 12 }}>Deadline: {incident.assignment.deadline || "Not set"} · Work order: {incident.assignment.work_order || "—"}</div></div>
                      <button onClick={() => unassign(incident)} disabled={saving} style={{ ...styles.button, background: "#7f1d1d" }}>Remove assignment</button>
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 9, alignItems: "end" }}>
                      <div><label style={styles.label}>Select contractor</label><select style={styles.input} value={assignments[incident.incident_id]?.contractor_id || ""} onChange={e => setAssignments(v => ({ ...v, [incident.incident_id]: { ...v[incident.incident_id], contractor_id: e.target.value } }))}><option value="">Choose contractor…</option>{contractors.filter(c => c.status === "Active").map(c => <option key={c.contractor_id} value={c.contractor_id}>{c.name}{c.company ? ` · ${c.company}` : ""}</option>)}</select></div>
                      <div><label style={styles.label}>Target completion date</label><input type="date" style={styles.input} value={assignments[incident.incident_id]?.deadline || ""} onChange={e => setAssignments(v => ({ ...v, [incident.incident_id]: { ...v[incident.incident_id], deadline: e.target.value } }))} /></div>
                      <div><label style={styles.label}>Work order reference</label><input style={styles.input} placeholder="Optional reference" value={assignments[incident.incident_id]?.work_order || ""} onChange={e => setAssignments(v => ({ ...v, [incident.incident_id]: { ...v[incident.incident_id], work_order: e.target.value } }))} /></div>
                      <button style={styles.button} disabled={saving || contractors.length === 0} onClick={() => assign(incident)}>Assign repair job →</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section style={styles.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <div><h2 style={{ margin: "0 0 5px", fontSize: 20 }}>Contractor directory</h2><p style={{ ...styles.muted, margin: 0, fontSize: 13 }}>Register approved repair contractors before assigning jobs.</p></div>
            <span style={{ color: "#93c5fd", fontSize: 13 }}>{contractors.length} registered</span>
          </div>
          <form onSubmit={addContractor} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
            {[
              ["name", "Contractor contact name", true],
              ["company", "Company / agency", false],
              ["phone", "Phone number", false],
              ["email", "Portal login email", true],
              ["password", "Initial portal password (8+ characters)", true],
              ["service_area", "Service area / ward", false],
              ["specialization", "Specialization", false],
            ].map(([key, label, required]) => <div key={key}><label style={styles.label}>{label}</label><input required={required} minLength={key === "password" ? 8 : undefined} type={key === "password" ? "password" : key === "email" ? "email" : "text"} style={styles.input} value={form[key]} onChange={e => updateForm(key, e.target.value)} placeholder={label} /></div>)}
            <div style={{ display: "flex", alignItems: "end" }}><button type="submit" disabled={saving} style={{ ...styles.button, width: "100%" }}>{saving ? "Saving…" : "+ Register contractor"}</button></div>
          </form>
          {contractors.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 18 }}>{contractors.map(c => <div key={c.contractor_id} style={{ border: "1px solid #263852", borderRadius: 10, padding: 12 }}><strong>{c.name}</strong><div style={{ ...styles.muted, fontSize: 12 }}>{c.company || "Independent contractor"} · {c.service_area || "Area not specified"}</div><div style={{ ...styles.muted, fontSize: 12, marginTop: 5 }}>{c.phone || c.email || "No contact details"}</div><div style={{ marginTop: 10 }}><input type="password" minLength={8} placeholder="Set / reset portal password" style={styles.input} value={credentialPasswords[c.contractor_id] || ""} onChange={e => setCredentialPasswords(v => ({ ...v, [c.contractor_id]: e.target.value }))} /><button disabled={saving || !c.email} onClick={() => saveContractorPassword(c)} style={{ ...styles.button, width: "100%", marginTop: 7 }}>Configure portal access</button></div></div>)}</div>}
        </section>
        <p style={{ ...styles.muted, fontSize: 11, marginTop: 18 }}>MVP note: GPS clustering and priority scores are decision-support estimates. Safety, traffic and road-importance values currently use neutral defaults unless supplied by verified data. An authorised municipal officer must validate priorities and contractor eligibility.</p>
      </div>
    </main>
  );
}
