"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || "https://smartroad-ai.onrender.com";
const STAGES = ["In Review", "Assigned", "Inspection Scheduled", "In Progress", "Site Verification", "Completed"];
const STATUS_LABELS = {
  "In Review": "Under review",
  "Under Review": "Under review",
  "Assigned": "Officer assigned",
  "Inspection Scheduled": "Inspection scheduled",
  "In Progress": "Work in progress",
  "Site Verification": "Verification",
  "Completed": "Resolved",
  "Resolved": "Resolved",
  "False Image/Rejected": "Rejected",
  "Rejected": "Rejected",
  "Needs More Information": "Action required",
  "Duplicate": "Closed as duplicate",
  "Reopened": "Reopened"
};
const dateText = value => value ? new Date(value).toLocaleString() : "Date unavailable";
const statusText = status => STATUS_LABELS[status] || status || "Status unavailable";
const isClosed = status => ["Completed", "Resolved", "Rejected", "False Image/Rejected", "Duplicate"].includes(status);

export default function MyComplaintsPage() {
  const [reports, setReports] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState("All");
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
      const response = await fetch(`${API}/user/complaints`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      const result = await response.json();
      if (response.status === 401) {
        setSignedIn(false);
        setReports([]);
        return;
      }
      if (!response.ok || !result.success) throw new Error(result.detail || result.message || "Could not load complaints.");
      setSignedIn(true);
      setReports(result.data || []);
      setSelectedId(current => current && result.data?.some(report => String(report.id) === String(current)) ? current : result.data?.[0]?.id ?? null);
    } catch (err) {
      setError(err.message || "Unable to connect to the complaint service.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadReports(); }, [loadReports]);

  const filtered = useMemo(() => reports.filter(report => {
    const status = report.status || "In Review";
    if (filter === "In progress") return !isClosed(status) && status !== "Needs More Information";
    if (filter === "Resolved") return ["Completed", "Resolved"].includes(status);
    if (filter === "Action required") return status === "Needs More Information" || status === "Reopened";
    return true;
  }), [reports, filter]);

  const selected = reports.find(report => String(report.id) === String(selectedId)) || filtered[0] || null;
  const activeCount = reports.filter(report => !isClosed(report.status || "In Review")).length;
  const resolvedCount = reports.filter(report => ["Completed", "Resolved"].includes(report.status)).length;

  const styles = {
    page: { minHeight: "100vh", background: "linear-gradient(145deg,#071426,#0b1d32 55%,#071426)", color: "#e5edf7", padding: "42px 18px 80px", fontFamily: "Arial,sans-serif" },
    wrap: { maxWidth: 1120, margin: "0 auto" },
    muted: { color: "#93a7bf" },
    panel: { background: "rgba(13,31,52,.88)", border: "1px solid rgba(148,181,215,.15)", borderRadius: 18, padding: 20 },
    button: { border: "1px solid rgba(148,181,215,.22)", borderRadius: 10, background: "#102943", color: "#dcecff", padding: "10px 14px", cursor: "pointer" }
  };

  return <main style={styles.page}>
    <div style={styles.wrap}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:16,flexWrap:"wrap",marginBottom:28}}>
        <div>
          <Link href="/" style={{color:"#65c9ee",textDecoration:"none",fontSize:13}}>← Back to SmartRoad AI</Link>
          <h1 style={{fontSize:"clamp(28px,4vw,38px)",margin:"14px 0 8px"}}>My Complaints</h1>
          <p style={styles.muted}>Track the reports you have submitted and follow every official update.</p>
        </div>
        <button onClick={loadReports} style={styles.button}>↻ Refresh updates</button>
      </div>

      {!signedIn && !loading ? <section style={{...styles.panel,textAlign:"center",padding:"48px 22px"}}>
        <div style={{fontSize:38,marginBottom:12}}>🔐</div>
        <h2 style={{fontSize:22,margin:"0 0 10px"}}>Sign in to track your complaints</h2>
        <p style={{...styles.muted,maxWidth:480,margin:"0 auto 20px",lineHeight:1.6}}>Your complaint history is private and can only be viewed using the account that submitted the reports. Sign in from the home page, then return here.</p>
        <Link href="/" style={{display:"inline-block",background:"#087eae",color:"#fff",padding:"12px 20px",borderRadius:10,textDecoration:"none"}}>Go to sign in</Link>
      </section> : loading ? <section style={styles.panel}>Loading your complaints…</section> : error ? <section style={{...styles.panel,borderColor:"rgba(248,113,113,.4)"}}>
        <strong>Unable to load complaints</strong><p style={styles.muted}>{error}</p><button onClick={loadReports} style={styles.button}>Try again</button>
      </section> : <>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:20}}>
          {[["Total reports",reports.length],["In progress",activeCount],["Resolved",resolvedCount]].map(([label,value])=><div key={label} style={styles.panel}><div style={{fontSize:28,fontWeight:700}}>{value}</div><div style={{...styles.muted,fontSize:13,marginTop:5}}>{label}</div></div>)}
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:18}}>
          {["All","In progress","Resolved","Action required"].map(item=><button key={item} onClick={()=>setFilter(item)} style={{...styles.button,background:filter===item?"#087eae":"#102943",borderColor:filter===item?"#36b9e9":"rgba(148,181,215,.22)"}}>{item}</button>)}
        </div>

        {reports.length===0 ? <section style={{...styles.panel,textAlign:"center",padding:44}}>
          <div style={{fontSize:36}}>🛣️</div><h2 style={{fontSize:21}}>No complaints submitted yet</h2>
          <p style={styles.muted}>When you submit a road issue while signed in, it will appear here with its tracking history.</p>
          <Link href="/user-upload" style={{display:"inline-block",marginTop:12,color:"#65c9ee"}}>Report a road issue →</Link>
        </section> : filtered.length===0 ? <section style={styles.panel}>No complaints in this category.</section> : <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(100%,330px),1fr))",gap:18,alignItems:"start"}}>
          <section style={{display:"grid",gap:10}}>
            {filtered.map(report=><button key={report.id} onClick={()=>setSelectedId(report.id)} style={{...styles.panel,textAlign:"left",cursor:"pointer",borderColor:String(selected?.id)===String(report.id)?"#38bdf8":"rgba(148,181,215,.15)",background:String(selected?.id)===String(report.id)?"rgba(8,74,111,.45)":"rgba(13,31,52,.88)"}}>
              <div style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"center"}}>
                <strong>SR-{String(report.id).padStart(5,"0")}</strong>
                <span style={{fontSize:11,padding:"5px 9px",borderRadius:20,background:isClosed(report.status)?"rgba(34,197,94,.15)":"rgba(56,189,248,.14)",color:isClosed(report.status)?"#86efac":"#7dd3fc"}}>{statusText(report.status)}</span>
              </div>
              <div style={{fontWeight:600,margin:"12px 0 6px"}}>{report.description || report.location || "Road damage report"}</div>
              <div style={{...styles.muted,fontSize:12}}>Submitted {dateText(report.timestamp)}</div>
              <div style={{...styles.muted,fontSize:12,marginTop:6}}>Last update: {dateText(report.history?.[report.history.length-1]?.timestamp || report.timestamp)}</div>
            </button>)}
          </section>

          {selected && <section style={{...styles.panel,position:"sticky",top:18}}>
            <div style={{display:"flex",justifyContent:"space-between",gap:10,flexWrap:"wrap",alignItems:"center"}}>
              <div><div style={{...styles.muted,fontSize:12}}>COMPLAINT TRACKING ID</div><h2 style={{fontSize:22,margin:"5px 0"}}>SR-{String(selected.id).padStart(5,"0")}</h2></div>
              <span style={{padding:"6px 10px",borderRadius:20,background:"rgba(56,189,248,.14)",color:"#7dd3fc",fontSize:12}}>{statusText(selected.status)}</span>
            </div>
            <div style={{...styles.muted,fontSize:13,lineHeight:1.6,margin:"12px 0 18px"}}>{selected.description || selected.location || "Road damage report"}<br/>Submitted {dateText(selected.timestamp)} · {selected.type || "Report"} report</div>
            <div style={{borderTop:"1px solid rgba(148,181,215,.15)",paddingTop:16}}>
              <h3 style={{fontSize:16,margin:"0 0 18px"}}>Complaint progress</h3>
              {(selected.history?.length ? selected.history : [{status:selected.status||"In Review",message:"Your complaint was received and is awaiting review.",timestamp:selected.timestamp,actor:"System"}]).map((event,index,array)=><div key={index} style={{display:"flex",gap:12,minHeight:74}}>
                <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                  <div style={{width:25,height:25,borderRadius:"50%",background:index===array.length-1?"#087eae":"#176b58",display:"grid",placeItems:"center",fontSize:12,color:"#fff"}}>{index===array.length-1?"●":"✓"}</div>
                  {index!==array.length-1&&<div style={{width:2,flex:1,minHeight:38,background:"#245b59"}}/>}
                </div>
                <div style={{paddingBottom:15,flex:1}}>
                  <div style={{fontWeight:600,fontSize:14}}>{statusText(event.status)}</div>
                  <div style={{...styles.muted,fontSize:12,marginTop:4}}>{event.message || "Status updated"} · {dateText(event.timestamp)}</div>
                  <div style={{...styles.muted,fontSize:11,marginTop:3}}>Updated by {event.actor || "System"}</div>
                </div>
              </div>)}
            </div>
            <div style={{background:"rgba(8,126,174,.12)",border:"1px solid rgba(56,189,248,.2)",borderRadius:12,padding:14,marginTop:4}}>
              <div style={{fontWeight:700,fontSize:13,marginBottom:5}}>What happens next?</div>
              <div style={{fontSize:13,...styles.muted,lineHeight:1.5}}>{isClosed(selected.status) ? (selected.status==="Completed"||selected.status==="Resolved" ? "This complaint is marked resolved. If the road issue remains, contact the authority and request a review." : "This complaint has been closed. Review the latest update for the recorded reason.") : selected.status==="Needs More Information" ? "Please provide the additional information requested by the department." : "The responsible department will update this timeline when the next action is recorded. Check back for the latest status."}</div>
            </div>
            {selected.note && <p style={{...styles.muted,fontSize:12,marginTop:12}}>{selected.note}</p>}
          </section>}
        </div>}
      </>}
      <p style={{...styles.muted,fontSize:11,marginTop:28,lineHeight:1.5}}>Status updates are shown from the complaint records available to SmartRoad AI. A displayed stage reflects the latest recorded action, not a guarantee of a repair completion date.</p>
    </div>
  </main>;
}
