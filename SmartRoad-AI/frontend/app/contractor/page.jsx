"use client";

import { useCallback, useEffect, useState } from "react";

const API = (process.env.NEXT_PUBLIC_BACKEND_URL || "").replace(/\/+$/, "");
const palette = { bg: "#07101f", panel: "#101c30", line: "#293b56", text: "#e5edf8", muted: "#91a4bf", blue: "#3b82f6", green: "#4ade80", orange: "#fb923c" };

async function api(path, token, options = {}) {
  if (!API) throw new Error("Backend URL is not configured.");
  const response = await fetch(API + path, {
    ...options,
    headers: { ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.detail || data.message || "Request failed");
  return data;
}

export default function ContractorPortal() {
  const [token, setToken] = useState("");
  const [contractor, setContractor] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [files, setFiles] = useState({});

  const refresh = useCallback(async (session) => {
    const [me, work] = await Promise.all([api("/contractor/auth/me", session), api("/contractor/jobs", session)]);
    setContractor(me.data);
    setJobs(work.data || []);
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("roadguard_contractor_token");
    if (saved) {
      setToken(saved);
      refresh(saved).catch(() => { window.localStorage.removeItem("roadguard_contractor_token"); setToken(""); });
    }
  }, [refresh]);

  async function login(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const form = new FormData(); form.append("email", email); form.append("password", password);
      const result = await api("/contractor/auth/login", "", { method: "POST", body: form });
      window.localStorage.setItem("roadguard_contractor_token", result.data.token);
      setToken(result.data.token); setPassword("");
      await refresh(result.data.token);
      setNotice("Welcome to your repair workspace.");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function logout() {
    window.localStorage.removeItem("roadguard_contractor_token");
    setToken(""); setContractor(null); setJobs([]);
  }

  async function jobAction(job, action) {
    setBusy(true); setError(""); setNotice("");
    try {
      await api(`/contractor/jobs/${job.incident_id}/status`, token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      await refresh(token);
      setNotice(action === "submit_for_verification" ? "Repair submitted for municipal verification." : action === "start" ? "Work marked as started." : "Job accepted.");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function uploadEvidence(job, type) {
    const file = files[`${job.incident_id}_${type}`];
    if (!file) { setError(`Choose a ${type}-repair photo first.`); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const body = new FormData(); body.append("evidence_type", type); body.append("file", file);
      await api(`/contractor/jobs/${job.incident_id}/evidence`, token, { method: "POST", body });
      await refresh(token);
      setFiles(current => ({ ...current, [`${job.incident_id}_${type}`]: null }));
      setNotice(`${type === "before" ? "Before" : "After"} photo uploaded.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const page = { minHeight: "100vh", background: palette.bg, color: palette.text, padding: "28px clamp(16px, 4vw, 48px)", fontFamily: "Arial,sans-serif" };
  const card = { background: palette.panel, border: `1px solid ${palette.line}`, borderRadius: 16, padding: 20 };
  const input = { width: "100%", boxSizing: "border-box", padding: 12, borderRadius: 9, border: `1px solid ${palette.line}`, background: "#081426", color: palette.text };
  const button = { border: 0, borderRadius: 9, padding: "11px 15px", background: palette.blue, color: "white", fontWeight: 700, cursor: "pointer" };

  if (!token || !contractor) return (
    <main style={{ ...page, display: "grid", placeItems: "center" }}>
      <form onSubmit={login} style={{ ...card, width: "min(430px, 100%)", boxSizing: "border-box" }}>
        <div style={{ color: "#60a5fa", fontSize: 11, letterSpacing: 2, fontWeight: 800 }}>ROADGUARD AI · CONTRACTOR ACCESS</div>
        <h1 style={{ margin: "10px 0 6px", fontSize: 30 }}>Contractor portal</h1>
        <p style={{ color: palette.muted, lineHeight: 1.5 }}>Sign in to view assigned road repairs, update job progress and submit repair evidence.</p>
        {error && <p role="alert" style={{ color: "#fda4af" }}>{error}</p>}
        <label style={{ display: "block", margin: "16px 0 6px", color: palette.muted, fontSize: 12 }}>Registered email</label>
        <input style={input} type="email" required value={email} onChange={e => setEmail(e.target.value)} />
        <label style={{ display: "block", margin: "16px 0 6px", color: palette.muted, fontSize: 12 }}>Portal password</label>
        <input style={input} type="password" required value={password} onChange={e => setPassword(e.target.value)} />
        <button style={{ ...button, width: "100%", marginTop: 18 }} disabled={busy}>{busy ? "Signing in…" : "Sign in to workspace"}</button>
        <p style={{ color: "#7387a3", fontSize: 11, marginTop: 16 }}>Portal access is created by the municipal administrator when registering your contractor account.</p>
      </form>
    </main>
  );

  return (
    <main style={page}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <div><div style={{ color: "#60a5fa", fontSize: 11, letterSpacing: 2, fontWeight: 800 }}>ROADGUARD AI · FIELD OPERATIONS</div><h1 style={{ fontSize: "clamp(26px,4vw,38px)", margin: "7px 0" }}>My repair jobs</h1><div style={{ color: palette.muted }}>{contractor.name} · {contractor.company || "Independent contractor"} · {contractor.service_area || "Service area not set"}</div></div>
          <button onClick={logout} style={{ ...button, background: "#26364e" }}>Sign out</button>
        </header>
        {error && <div role="alert" style={{ padding: 12, borderRadius: 9, background: "#451b2b", color: "#fecdd3", marginBottom: 12 }}>{error}</div>}
        {notice && <div role="status" style={{ padding: 12, borderRadius: 9, background: "#123629", color: "#bbf7d0", marginBottom: 12 }}>{notice}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 20 }}>
          {[[ "Assigned jobs", jobs.length ],[ "Awaiting verification", jobs.filter(j => j.status === "Site Verification").length ],[ "Critical / high", jobs.filter(j => ["Critical","High"].includes(j.priority_band)).length ]].map(([label,value]) => <div key={label} style={card}><div style={{ color: palette.muted, fontSize: 12 }}>{label}</div><div style={{ fontSize: 30, fontWeight: 800, marginTop: 8 }}>{value}</div></div>)}
        </div>
        {jobs.length === 0 ? <div style={card}><h2>No repair jobs assigned</h2><p style={{ color: palette.muted }}>When the municipal administrator assigns a road incident to your contractor account, it will appear here.</p></div> : <div style={{ display: "grid", gap: 16 }}>
          {jobs.map(job => {
            const evidence = job.contractor_work?.evidence || [];
            const before = evidence.filter(item => item.type === "before");
            const after = evidence.filter(item => item.type === "after");
            const status = job.contractor_work?.status || job.assignment?.status || "Assigned";
            return <article key={job.incident_id} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div><div style={{ color: "#8da0ba", fontSize: 11 }}>{job.incident_id} · {job.priority_band} PRIORITY</div><h2 style={{ margin: "7px 0" }}>{job.location}</h2><div style={{ color: palette.muted, fontSize: 13 }}>{job.description || "Road damage repair"} · {job.supporting_reports} citizen report(s)</div></div>
                <div style={{ textAlign: "right" }}><div style={{ color: palette.green, fontWeight: 800 }}>{status}</div><div style={{ color: palette.muted, fontSize: 12, marginTop: 5 }}>Due: {job.assignment?.deadline || "Not specified"}</div></div>
              </div>
              {job.assignment?.work_order && <p style={{ color: palette.muted, fontSize: 12 }}>Work order: {job.assignment.work_order}</p>}
              {job.assignment?.notes && <p style={{ color: palette.muted, fontSize: 13 }}>Admin instructions: {job.assignment.notes}</p>}
              {job.lat != null && job.lng != null && <a target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${job.lat},${job.lng}`} style={{ color: "#93c5fd", fontSize: 13 }}>Open job location ↗</a>}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 12, marginTop: 18 }}>
                {["before","after"].map(type => <div key={type} style={{ border: `1px solid ${palette.line}`, borderRadius: 11, padding: 12 }}>
                  <strong style={{ textTransform: "capitalize" }}>{type}-repair photos</strong><p style={{ color: palette.muted, fontSize: 12 }}>{type === "before" ? "Document the site condition before work." : "Upload clear evidence after the repair is complete."}</p>
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setFiles(v => ({ ...v, [`${job.incident_id}_${type}`]: e.target.files?.[0] || null }))} style={{ color: palette.muted, width: "100%", fontSize: 12 }} />
                  <button disabled={busy} onClick={() => uploadEvidence(job,type)} style={{ ...button, marginTop: 10, width: "100%", background: type === "before" ? "#334155" : "#166534" }}>Upload {type} photo</button>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 }}>{(type === "before" ? before : after).map((item,i) => <a key={i} href={API + item.url} target="_blank" rel="noreferrer"><img src={API + item.url} alt={type + " repair evidence"} style={{ width: 76, height: 60, objectFit: "cover", borderRadius: 7, border: `1px solid ${palette.line}` }} /></a>)}</div>
                </div>)}
              </div>
              <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginTop: 16 }}>
                {status === "Assigned" && <button disabled={busy} style={button} onClick={() => jobAction(job,"accept")}>Accept job</button>}
                {["Assigned","Accepted"].includes(status) && <button disabled={busy} style={{ ...button, background: "#0f766e" }} onClick={() => jobAction(job,"start")}>Start repair</button>}
                {["Work Started","In Progress"].includes(status) && <button disabled={busy} style={{ ...button, background: "#7c3aed" }} onClick={() => jobAction(job,"submit_for_verification")}>Submit for verification</button>}
                {status === "Submitted for Verification" && <span style={{ color: "#c4b5fd", alignSelf: "center", fontSize: 13 }}>Submitted — awaiting municipal review</span>}
                {job.contractor_work?.verification_note && <span style={{ color: "#fbbf24", alignSelf: "center", fontSize: 13 }}>Municipal note: {job.contractor_work.verification_note}</span>}
              </div>
            </article>;
          })}
        </div>}
      </div>
    </main>
  );
}
