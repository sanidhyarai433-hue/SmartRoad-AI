"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const API = (process.env.NEXT_PUBLIC_BACKEND_URL || "https://smartroad-ai.onrender.com").replace(/\/+$/, "");
const dateText = value => value ? new Date(value).toLocaleString() : "Date unavailable";
const severityOf = report => report.priority || (report.severity?.Major ? "Major" : report.severity?.Moderate ? "Moderate" : report.severity?.Minor ? "Minor" : "Not classified");

export default function MyReportsPage() {
  const router = useRouter();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(true);

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError("");
    const token = typeof window !== "undefined" ? localStorage.getItem("sr_token") : null;
    if (!token) {
      setSignedIn(false);
      setReports([]);
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(`${API}/user/reports`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setSignedIn(false);
        setReports([]);
        return;
      }
      if (!response.ok || !result.success) throw new Error(result.detail || result.message || "Could not load your reports.");
      setSignedIn(true);
      setReports(Array.isArray(result.data) ? result.data : []);
    } catch (err) {
      setError(err.message || "Unable to connect to the report service.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadReports(); }, [loadReports]);

  const styles = {
    page: { minHeight: "100vh", background: "linear-gradient(145deg,#071426,#0b1d32 55%,#071426)", color: "#e5edf7", padding: "42px 18px 80px", fontFamily: "Arial,sans-serif" },
    wrap: { maxWidth: 1080, margin: "0 auto" },
    muted: { color: "#93a7bf", lineHeight: 1.6 },
    panel: { background: "rgba(13,31,52,.9)", border: "1px solid rgba(148,181,215,.16)", borderRadius: 16, padding: 20 },
    button: { border: "1px solid rgba(148,181,215,.22)", borderRadius: 10, background: "#102943", color: "#dcecff", padding: "10px 14px", cursor: "pointer", fontWeight: 700 }
  };

  return <main style={styles.page}>
    <div style={styles.wrap}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:16,flexWrap:"wrap",marginBottom:26}}>
        <div>
          <Link href="/" style={{color:"#65c9ee",textDecoration:"none",fontSize:13}}>← Back to SmartRoad AI</Link>
          <h1 style={{fontSize:"clamp(28px,4vw,38px)",margin:"14px 0 8px"}}>My Reports</h1>
          <p style={styles.muted}>Your AI-generated reports, including drafts waiting for your confirmation. Open any report to review the written details or save the document as a PDF.</p>
        </div>
        <button onClick={loadReports} style={styles.button}>↻ Refresh reports</button>
      </div>

      {!signedIn && !loading ? <section style={{...styles.panel,textAlign:"center",padding:44}}>
        <div style={{fontSize:36,marginBottom:10}}>🔐</div>
        <h2>Sign in to view your reports</h2>
        <p style={{...styles.muted,maxWidth:480,margin:"10px auto 18px"}}>Reports are private and linked to the account used when you created them. Sign in from the home page and return here.</p>
        <Link href="/" style={{display:"inline-block",background:"#087eae",color:"#fff",padding:"12px 20px",borderRadius:10,textDecoration:"none"}}>Go to sign in</Link>
      </section> : loading ? <section style={styles.panel}>Loading your reports…</section> : error ? <section style={styles.panel}>
        <strong>Unable to load reports</strong><p style={styles.muted}>{error}</p><button onClick={loadReports} style={styles.button}>Try again</button>
      </section> : reports.length === 0 ? <section style={{...styles.panel,textAlign:"center",padding:44}}>
        <div style={{fontSize:38}}>📄</div><h2 style={{margin:"10px 0"}}>No reports yet</h2>
        <p style={styles.muted}>After AI detection, your draft report appears here immediately. You can open it, review it, and submit it when ready.</p>
        <Link href="/user-upload" style={{display:"inline-block",marginTop:14,color:"#65c9ee"}}>Create a road report →</Link>
      </section> : <>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:18}}>
          <div style={styles.panel}><div style={{fontSize:28,fontWeight:800}}>{reports.length}</div><div style={styles.muted}>Total reports</div></div>
          <div style={styles.panel}><div style={{fontSize:28,fontWeight:800}}>{reports.filter(r => String(r.submission_status || "").toLowerCase() !== "submitted" && String(r.status || "").toLowerCase() === "pending submission").length}</div><div style={styles.muted}>Draft / pending</div></div>
          <div style={styles.panel}><div style={{fontSize:28,fontWeight:800}}>{reports.filter(r => String(r.submission_status || "").toLowerCase() === "submitted" || (r.status && String(r.status).toLowerCase() !== "pending submission")).length}</div><div style={styles.muted}>Submitted</div></div>
        </div>
        <div style={{display:"grid",gap:12}}>
          {reports.map(report => {
            const isSubmitted = String(report.submission_status || "").toLowerCase() === "submitted";
            return <article key={report.id} style={{...styles.panel,display:"flex",justifyContent:"space-between",alignItems:"center",gap:18,flexWrap:"wrap"}}>
              <div style={{minWidth:0,flex:"1 1 360px"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <strong style={{fontSize:17}}>SR-{String(report.id).padStart(5,"0")}</strong>
                  <span style={{fontSize:11,padding:"5px 9px",borderRadius:20,background:isSubmitted?"rgba(34,197,94,.14)":"rgba(245,158,11,.14)",color:isSubmitted?"#86efac":"#fcd34d"}}>{isSubmitted ? "Submitted" : "Draft / Pending submission"}</span>
                </div>
                <h2 style={{fontSize:16,margin:"10px 0 6px",overflowWrap:"anywhere"}}>{report.road_name || report.location || "Road damage report"}</h2>
                <div style={{...styles.muted,fontSize:13}}>{report.damage_type || "Road damage"} · {severityOf(report)} · {Number(report.detections || 0)} detected issue(s)</div>
                <div style={{...styles.muted,fontSize:12,marginTop:6}}>Created {dateText(report.timestamp)}{report.submitted_at ? ` · Submitted ${dateText(report.submitted_at)}` : ""}</div>
              </div>
              <button style={{...styles.button,background:"#087eae",borderColor:"#38bdf8"}} onClick={() => router.push(`/complaint-report/${report.id}`)}>Open report & PDF →</button>
            </article>;
          })}
        </div>
      </>}
      <p style={{...styles.muted,fontSize:11,marginTop:24}}>Each report includes complainant details available on your account, AI detection results, severity, location, evidence images, complaint description and submission status. Fields not supplied or captured are marked as unavailable in the report.</p>
    </div>
  </main>;
}
