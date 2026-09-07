"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "./api";

type Athlete = { id: string; name?: string };
type Assignment = { id: string; trackId: string; athleteId: string | null; reason: string; actorName?: string; createdAt: string; supersedesAssignmentId?: string };
type AssignmentResponse = { assignments: Assignment[]; currentByTrack: Record<string, Assignment>; athletes: Athlete[] };

export function TrackAssignmentPanel({ videoId, trackIds }: { videoId: string; trackIds: string[] }) {
  const [data, setData] = useState<AssignmentResponse>({ assignments: [], currentByTrack: {}, athletes: [] });
  const [reasonByTrack, setReasonByTrack] = useState<Record<string, string>>({});
  const [selectedByTrack, setSelectedByTrack] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const load = async () => setData(await apiRequest<AssignmentResponse>(`/api/v1/videos/${videoId}/track-assignments`));

  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Não foi possível carregar atribuições.")); }, [videoId]);
  if (!trackIds.length) return null;

  const save = async (trackId: string) => {
    const current = data.currentByTrack[trackId];
    const athleteId = selectedByTrack[trackId] ?? current?.athleteId ?? "";
    const reason = reasonByTrack[trackId]?.trim() ?? "";
    if (reason.length < 3) { setError("Informe o motivo da associação ou correção."); return; }
    setError("");
    try {
      await apiRequest(`/api/v1/videos/${videoId}/tracks/${encodeURIComponent(trackId)}/assignments`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ athleteId: athleteId || null, reason }),
      });
      setReasonByTrack((currentReasons) => ({ ...currentReasons, [trackId]: "" }));
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registrar a atribuição."); }
  };

  return <section className="track-assignment-panel" aria-label="Atribuição manual de tracks">
    <span className="eyebrow accent">ATRIBUIÇÃO HUMANA</span>
    <p>Tracks são identificadores técnicos. Nenhuma pessoa é reconhecida automaticamente e o contexto do upload não é usado como atribuição.</p>
    {trackIds.map((trackId) => {
      const current = data.currentByTrack[trackId];
      const history = data.assignments.filter((assignment) => assignment.trackId === trackId).slice(-3).reverse();
      return <div className="track-assignment-row" key={trackId}>
        <b>Track técnico #{trackId}</b>
        <label><span>Atleta nominal</span><select aria-label={`Atleta nominal para track ${trackId}`} value={selectedByTrack[trackId] ?? current?.athleteId ?? ""} onChange={(event) => setSelectedByTrack((selected) => ({ ...selected, [trackId]: event.target.value }))}><option value="">Não associado</option>{data.athletes.map((athlete) => <option key={athlete.id} value={athlete.id}>{athlete.name ?? athlete.id}</option>)}</select></label>
        <label><span>Motivo</span><input aria-label={`Motivo para track ${trackId}`} value={reasonByTrack[trackId] ?? ""} onChange={(event) => setReasonByTrack((reasons) => ({ ...reasons, [trackId]: event.target.value }))} placeholder="Ex.: conferido pelo treinador" /></label>
        <button type="button" className="secondary-button" onClick={() => void save(trackId)}>Registrar versão</button>
        {history.length ? <small>Histórico: {history.map((item) => `${item.athleteId ? data.athletes.find((athlete) => athlete.id === item.athleteId)?.name ?? item.athleteId : "não associado"} · ${item.actorName ?? "comissão"}`).join(" → ")}</small> : <small>Sem associação registrada.</small>}
      </div>;
    })}
    {error ? <p className="modal-error" role="alert">{error}</p> : null}
  </section>;
}
