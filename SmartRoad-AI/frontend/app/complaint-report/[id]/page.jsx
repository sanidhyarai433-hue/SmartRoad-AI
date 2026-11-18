"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

const API = (process.env.NEXT_PUBLIC_BACKEND_URL || "https://smartroad-ai.onrender.com").replace(/\/+$/, "");
const textOr = value => value === null || value === undefined || String(value).trim() === "" ? "Not Provided" : String(value);
const dateText = value => value ? new Date(value).toLocaleString() : "Not Provided";
const mapUrl = (lat, lng) => {
  const x = Number(lng), y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const d = 0.003;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${x-d}%2C${y-d}%2C${x+d}%2C${y+d}&layer=mapnik&marker=${y}%2C${x}`;
};

export default function ComplaintReportPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id;
  const [report, setReport] = useState(null);
  const [description, setDescription] = useState("");
  const [locationText, setLocationText] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [geoAddress, setGeoAddress] = useState({});
  const [additionalFile, setAdditionalFile] = useState(null);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);

  const load = useCallback(async () => {
    const token = localStorage.getItem("sr_token");
    if (!token) {
      setError("Sign in with the account used to create this report before reviewing or submitting it.");
      return;
    }
    const response = await fetch(`${API}/user/complaints/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.detail || "Unable to load this complaint report.");
    setReport(result.data);
    setDescription(result.data.description || result.data.ai_summary || "");
    setLocationText(result.data.road_name || result.data.location || "");
    setLatitude(result.data.lat === null || result.data.lat === undefined ? "" : String(result.data.lat));
    setLongitude(result.data.lng === null || result.data.lng === undefined ? "" : String(result.data.lng));
  }, [id]);

  useEffect(() => {
    let active = true;
    load().catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [load]);

  // Reverse-geocode only the coordinates saved on this complaint. Never use
  // the viewer's current device location when opening an older report.
  useEffect(() => {
    if (report?.lat == null || report?.lng == null) return;
    let active = true;
    fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${report.lat}&lon=${report.lng}`, { headers: { "Accept-Language": "en" } })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!active || !data?.address) return;
        const a = data.address;
        setGeoAddress({
          road: a.road || a.pedestrian || a.highway,
          locality: a.suburb || a.neighbourhood || a.quarter || a.residential,
          city: a.city || a.town || a.village || a.municipality,
          district: a.county || a.state_district,
          state: a.state,
          pin: a.postcode,
        });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [report?.lat, report?.lng]);

  const detections = Array.isArray(report?.detection_details) ? report.detection_details : [];
  const breakdown = report?.severity || {};
  const total = Number(report?.detections ?? detections.length ?? 0);
  const severity = report?.priority || (breakdown.Major ? "Major" : breakdown.Moderate ? "Moderate" : breakdown.Minor ? "Minor" : "No detected damage");
  const confidence = useMemo(() => {
    const values = detections.map(item => Number(item.confidence)).filter(Number.isFinite);
    return values.length ? `${(values.reduce((a,b) => a+b, 0) / values.length * 100).toFixed(1)}%` : "Not Provided";
  }, [detections]);
  const map = mapUrl(report?.lat, report?.lng);
  const originalImage = report?.image_url ? (report.image_url.startsWith("http") ? report.image_url : `${API}${report.image_url}`) : null;
  const annotatedImage = report?.image_with_detections
    ? (report.image_with_detections.startsWith("data:") ? report.image_with_detections : `data:image/jpeg;base64,${report.image_with_detections}`)
    : null;
  const submitted = String(report?.submission_status || "").toLowerCase() === "submitted";

  async function saveDraft() {
    const token = localStorage.getItem("sr_token");
    const hasCoordinates = latitude.trim() !== "" && longitude.trim() !== "";
    const body = { description, location: locationText };
    if (hasCoordinates) { body.lat = Number(latitude); body.lng = Number(longitude); }
    if (hasCoordinates && (!Number.isFinite(body.lat) || !Number.isFinite(body.lng))) throw new Error("Enter valid GPS coordinates.");
    const response = await fetch(`${API}/user/complaints/${id}/draft`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.detail || "Could not save report edits.");
    setReport(result.data);
    setNotice("Your report changes have been saved.");
    setEditing(false);
  }

  async function uploadEvidence() {
    if (!additionalFile) return;
    setUploadingEvidence(true); setError(""); setNotice("");
    try {
      const form = new FormData();
      form.append("file", additionalFile);
      const token = localStorage.getItem("sr_token");
      const response = await fetch(`${API}/user/complaints/${id}/evidence`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.detail || "Could not attach this evidence.");
      setReport(current => ({ ...current, attachments: [...(current.attachments || []), result.data] }));
      setAdditionalFile(null);
      setNotice("Additional evidence attached to this complaint.");
    } catch (err) { setError(err.message); }
    finally { setUploadingEvidence(false); }
  }

  async function submitOfficial() {
    setSaving(true); setError(""); setNotice("");
    try {
      if (editing) await saveDraft();
      const token = localStorage.getItem("sr_token");
      const response = await fetch(`${API}/user/complaints/${id}/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.detail || "Official complaint submission failed.");
      setReport(result.data);
      setNotice("Official complaint submitted successfully.");
      router.push("/my-complaints");
    } catch (err) { setError(err.message || "Submission failed."); }
    finally { setSaving(false); }
  }

  function downloadPDF() {
    window.print();
  }

  const styles = {
    page: { minHeight: "100vh", background: "linear-gradient(145deg,#071426,#0b1d32 55%,#071426)", color: "#e5edf7", padding: "30px 16px 64px", fontFamily: "Arial,sans-serif" },
    wrap: { maxWidth: 1120, margin: "0 auto" },
    panel: { background: "rgba(13,31,52,.92)", border: "1px solid rgba(148,181,215,.16)", borderRadius: 16, padding: 20, minWidth: 0 },
    muted: { color: "#9bb0c7", fontSize: 13, lineHeight: 1.6 },
    label: { color: "#7dd3fc", fontSize: 10, fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 6 },
    value: { color: "#f1f5f9", fontSize: 14, overflowWrap: "anywhere" },
    input: { width: "100%", border: "1px solid rgba(148,181,215,.25)", borderRadius: 9, padding: "11px 12px", background: "#081a2d", color: "#f8fafc", font: "inherit" },
    button: { border: "1px solid rgba(148,181,215,.25)", borderRadius: 10, background: "#102943", color: "#e2e8f0", padding: "11px 15px", cursor: "pointer", fontWeight: 700 },
  };

  const field = (label, value) => <div key={label}><div style={styles.label}>{label}</div><div style={styles.value}>{textOr(value)}</div></div>;
  const sectionTitle = title => <h2 style={{ margin: "0 0 16px", fontSize: 16, letterSpacing: ".02em" }}>{title}</h2>;

  if (!report && !error) return <main style={styles.page}><div style={styles.wrap}><section style={styles.panel}>Loading official complaint report…</section></div></main>;
  if (!report && error) return <main style={styles.page}><div style={styles.wrap}><section style={styles.panel}><h1>Complaint report unavailable</h1><p style={styles.muted}>{error}</p><button style={styles.button} onClick={() => router.push("/user-upload")}>Return to report upload</button></section></div></main>;

  return <main style={styles.page}>
    <style>{`
      @media print {
        body { background: #fff !important; }
        .sr-report-page { background: #fff !important; color: #111827 !important; padding: 0 !important; }
        .sr-report-page section { background: #fff !important; color: #111827 !important; border: 1px solid #cbd5e1 !important; break-inside: avoid; }
        .sr-report-page h1,.sr-report-page h2,.sr-report-page p,.sr-report-page div,.sr-report-page span { color: #111827 !important; }
        .no-print { display: none !important; }
        .sr-report-page img { max-height: 260px !important; }
      }
    `}</style>
    <div className="sr-report-page" style={styles.wrap}>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <button style={styles.button} onClick={() => router.back()}>← Back</button>
        <span style={{ ...styles.muted, color: "#67e8f9" }}>SMART CITY · CITIZEN SERVICES</span>
      </div>

      <header style={{ ...styles.panel, borderColor: "rgba(56,189,248,.38)", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ color: "#67e8f9", fontWeight: 900, letterSpacing: ".16em", fontSize: 12 }}>◈ SMARTROAD AI</div>
            <h1 style={{ fontSize: "clamp(23px,4vw,34px)", margin: "12px 0 6px" }}>Official Road Damage Complaint Report</h1>
            <p style={styles.muted}>Citizen-submitted road condition evidence and AI-assisted inspection record</p>
          </div>
          <div style={{ minWidth: 180, textAlign: "right" }}>
            <div style={styles.label}>Complaint ID</div>
            <div style={{ fontSize: 25, fontWeight: 900, letterSpacing: ".04em" }}>SR-{String(report.id).padStart(5,"0")}</div>
            <div style={{ marginTop: 8, display: "inline-block", padding: "6px 10px", borderRadius: 30, background: submitted ? "rgba(34,197,94,.15)" : "rgba(245,158,11,.15)", color: submitted ? "#86efac" : "#fcd34d", fontSize: 11, fontWeight: 800 }}>{submitted ? "SUBMITTED" : "PENDING SUBMISSION"}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 20, paddingTop: 14, borderTop: "1px solid rgba(148,181,215,.16)" }}>
          <div><div style={styles.label}>Created</div><div style={styles.value}>{dateText(report.timestamp)}</div></div>
          <div><div style={styles.label}>Submitted</div><div style={styles.value}>{dateText(report.submitted_at)}</div></div>
          <div><div style={styles.label}>Report type</div><div style={styles.value}>AI-assisted road damage</div></div>
        </div>
      </header>

      {error && <div style={{ ...styles.panel, borderColor: "#ef4444", color: "#fecaca", marginBottom: 14 }}>{error}</div>}
      {notice && <div style={{ ...styles.panel, borderColor: "#10b981", color: "#a7f3d0", marginBottom: 14 }}>{notice}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))", gap: 14 }}>
        <section style={styles.panel}>
          {sectionTitle("01 · Complainant information")}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 18 }}>
            {field("Full name", report.uploader_name)}
            {field("User ID", report.uploader_id)}
            {field("Registered email", report.uploader_email)}
            {field("Phone number", report.uploader_phone)}
            {field("Complaint submitted by", report.uploader_name)}
            {field("Submission timestamp", report.submitted_at || report.timestamp)}
          </div>
        </section>

        <section style={styles.panel}>
          {sectionTitle("02 · AI road damage inspection")}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 14 }}>
            {field("Damage type", report.damage_type || (total ? "Pothole" : "No damage detected"))}
            {field("Potholes detected", total)}
            {field("Total damage instances", total)}
            {field("Overall severity", severity)}
            {field("Average model confidence", confidence)}
            {field("Severity method", report.severity_method === "bounding_box_pixel_area_heuristic_not_physical_measurement" ? "Bounding-box pixel-area estimate; not physical depth" : report.severity_method)}
          </div>
          <div style={{ marginTop: 16, padding: 13, borderRadius: 10, background: "rgba(8,126,174,.12)" }}>
            <div style={styles.label}>Detection summary</div>
            <p style={styles.value}>{total > 0 ? `The model identified ${total} pothole instance(s): ${Number(breakdown.Major || 0)} Major, ${Number(breakdown.Moderate || 0)} Moderate and ${Number(breakdown.Minor || 0)} Minor, based on the model's bounding-box area heuristic.` : "The model did not detect potholes in this image. A citizen may still submit the report for manual review."}</p>
          </div>
          <div style={{ marginTop: 16 }}>
            {sectionTitle("Individual detections")}
            {detections.length ? <div style={{ display: "grid", gap: 8 }}>{detections.map((item,index) => <div key={index} style={{ border: "1px solid rgba(148,181,215,.15)", borderRadius: 9, padding: 10, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><strong>Pothole {index+1} · {textOr(item.severity)}</strong><span style={styles.muted}>Confidence: {Number.isFinite(Number(item.confidence)) ? `${(Number(item.confidence)*100).toFixed(1)}%` : "Not Provided"} · Box: {Array.isArray(item.bbox) ? item.bbox.join(", ") : "Not Provided"}</span></div>)}</div> : <p style={styles.muted}>No individual pothole detections were returned by the model.</p>}
          </div>
        </section>

        <section style={styles.panel}>
          {sectionTitle("03 · Location information")}
          {editing ? <div style={{ display: "grid", gap: 10 }}>
            <label style={styles.label}>Road name / area description<input style={styles.input} value={locationText} onChange={e => setLocationText(e.target.value)} /></label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={styles.label}>Latitude<input style={styles.input} value={latitude} onChange={e => setLatitude(e.target.value)} placeholder="Latitude" /></label>
              <label style={styles.label}>Longitude<input style={styles.input} value={longitude} onChange={e => setLongitude(e.target.value)} placeholder="Longitude" /></label>
            </div>
          </div> : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 16 }}>
            {field("Road name / captured address", report.road_name || geoAddress.road || report.location)}
            {field("Latitude", report.lat)}
            {field("Longitude", report.lng)}
            {field("Area / locality", report.locality || geoAddress.locality)}
            {field("City", report.city || geoAddress.city)}
            {field("District", report.district || geoAddress.district)}
            {field("State", report.state || geoAddress.state)}
            {field("PIN code", report.pin_code || geoAddress.pin)}
            {field("Location capture", report.location_resolution)}
          </div>}
          {map ? <div style={{ marginTop: 16 }}>
            <iframe title="Complaint location map" src={map} style={{ width: "100%", height: 250, border: 0, borderRadius: 10 }} loading="lazy" />
            <a href={`https://www.google.com/maps?q=${report.lat},${report.lng}`} target="_blank" rel="noreferrer" style={{ color: "#67e8f9", fontSize: 13, display: "inline-block", marginTop: 10 }}>Open exact coordinates in Google Maps ↗</a>
          </div> : <p style={styles.muted}>No GPS coordinates were captured. Use Edit Report to add the correct location before submitting.</p>}
        </section>

        <section style={styles.panel}>
          {sectionTitle("04 · Complaint description")}
          {editing ? <textarea style={{ ...styles.input, minHeight: 150, resize: "vertical" }} value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} /> : <p style={{ ...styles.value, lineHeight: 1.75 }}>{textOr(report.description || report.ai_summary)}</p>}
          <p style={{ ...styles.muted, marginTop: 12 }}>This description is citizen-editable. AI findings above remain the actual model output and are not changed by editing this text.</p>
        </section>

        <section style={{ ...styles.panel, gridColumn: "1 / -1" }}>
          {sectionTitle("05 · Evidence and attachments")}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))", gap: 14 }}>
            <div><div style={styles.label}>Original uploaded evidence</div>{report.type === "video" && report.artifacts?.original ? <video src={`${API}${report.artifacts.original}`} controls style={{ width: "100%", maxHeight: 340, borderRadius: 10, background: "#06111f" }} /> : originalImage ? <img src={originalImage} alt="Original road evidence" style={{ width: "100%", maxHeight: 340, objectFit: "contain", borderRadius: 10, background: "#06111f" }} /> : <p style={styles.muted}>Original evidence unavailable.</p>}</div>
            <div><div style={styles.label}>AI annotated evidence</div>{report.type === "video" && report.artifacts?.annotated ? <video src={`${API}${report.artifacts.annotated}`} controls style={{ width: "100%", maxHeight: 340, borderRadius: 10, background: "#06111f" }} /> : annotatedImage ? <img src={annotatedImage} alt="AI annotated road evidence" style={{ width: "100%", maxHeight: 340, objectFit: "contain", borderRadius: 10, background: "#06111f" }} /> : <p style={styles.muted}>Annotated evidence unavailable.</p>}</div>
          </div>
          <div style={{ ...styles.muted, marginTop: 12 }}>Original file: {textOr(report.original_file_name)} · Uploaded: {dateText(report.timestamp)}</div>
          <div style={{ marginTop: 18 }}>
            <div style={styles.label}>Additional evidence</div>
            {(report.attachments || []).length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginBottom: 12 }}>{report.attachments.map((item,index) => <div key={index} style={{ border: "1px solid rgba(148,181,215,.15)", borderRadius: 9, padding: 8 }}><img src={item.image_url?.startsWith("http") ? item.image_url : `${API}${item.image_url}`} alt={item.file_name || "Additional evidence"} style={{ width: "100%", height: 110, objectFit: "cover", borderRadius: 6 }} /><div style={{ ...styles.muted, fontSize: 11, marginTop: 6 }}>{item.file_name}</div><div style={{ ...styles.muted, fontSize: 10 }}>{dateText(item.uploaded_at)}</div></div>)}</div>}
            {!submitted && <div className="no-print" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setAdditionalFile(e.target.files?.[0] || null)} style={{ color: "#cbd5e1", maxWidth: "100%" }} />
              <button style={styles.button} disabled={!additionalFile || uploadingEvidence} onClick={uploadEvidence}>{uploadingEvidence ? "Uploading…" : "Attach evidence"}</button>
            </div>}
            {!report.attachments?.length && <p style={styles.muted}>No additional evidence attached.</p>}
          </div>
        </section>

        <section style={{ ...styles.panel, gridColumn: "1 / -1", borderColor: severity === "Critical" || severity === "Major" ? "rgba(248,113,113,.4)" : "rgba(148,181,215,.16)" }}>
          {sectionTitle("06 · Complaint priority")}
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <div style={{ fontSize: 23, fontWeight: 900, color: severity === "Critical" || severity === "Major" ? "#fca5a5" : severity === "Moderate" ? "#fcd34d" : "#86efac" }}>{severity}</div>
            <p style={styles.muted}>{severity === "Critical" ? "Immediate attention requested based on the citizen's critical flag." : severity === "Major" ? "High priority based on the major damage detections." : severity === "Moderate" ? "Normal priority based on moderate damage detections." : severity === "Minor" ? "Low priority based on minor damage detections." : "No AI damage severity could be established from this image."}</p>
          </div>
        </section>
      </div>

      <footer className="no-print" style={{ ...styles.panel, marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {!submitted && <>
          <button style={styles.button} onClick={() => { setEditing(v => !v); setError(""); }}>{editing ? "Close editor" : "Edit Report"}</button>
          {editing && <button style={styles.button} disabled={saving} onClick={async () => { setSaving(true); setError(""); try { await saveDraft(); } catch (e) { setError(e.message); } finally { setSaving(false); } }}>Save changes</button>}
          <button style={{ ...styles.button, background: "#087eae", borderColor: "#38bdf8" }} disabled={saving} onClick={submitOfficial}>{saving ? "Submitting…" : "Submit Official Complaint"}</button>
        </>}
        <button style={styles.button} onClick={downloadPDF}>Download PDF Report</button>
        <button style={styles.button} onClick={() => router.back()}>Cancel</button>
      </footer>
      <p className="no-print" style={{ ...styles.muted, textAlign: "center", marginTop: 12 }}>PDF export opens the browser print dialog. Select “Save as PDF” to save a copy of this official report.</p>
    </div>
  </main>;
}
