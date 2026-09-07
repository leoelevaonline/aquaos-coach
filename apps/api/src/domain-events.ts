/**
 * Catálogo versionado dos eventos de domínio do RKF Coach (gate G08).
 * Cada evento possui versão, ator responsável e carga obrigatória mínima.
 * Publicadores emitem apenas eventos deste catálogo; consumidores validam
 * a versão antes de processar.
 */

export type DomainEventName =
  | "athlete.created" | "athlete.updated" | "athlete.anonymized"
  | "session.library.viewed" | "session.prescription.composed"
  | "session.prescription.saved" | "session.prescription.approved"
  | "session.prescription.published" | "session.prescription.pdf.exported"
  | "cycle.generated"
  | "training.ingestion.received" | "training.ingestion.stored"
  | "training.ingestion.extracted" | "training.ingestion.parsed"
  | "training.ingestion.reviewed" | "training.ingestion.corrected"
  | "training.ingestion.confirmed" | "training.ingestion.assigned"
  | "training.ingestion.committed" | "training.ingestion.failed"
  | "video.track.assignment.recorded"
  | "session.executed" | "session.result.recorded"
  | "load.layers.calculated" | "load.snapshot.committed"
  | "readiness.assessed" | "adaptation.decided"
  | "evolution.assessed" | "response.index.calculated"
  | "user.login" | "user.logout" | "user.login_failed"
  | "governance.decision.versioned" | "seed.imported" | "seed.staged"
  | "backup.created" | "backup.restored";

export type DomainEventContract = {
  name: DomainEventName;
  version: string;
  actor: "coach" | "athlete" | "admin" | "system";
  payload: string[];
};

export const DOMAIN_EVENT_CATALOG_VERSION = "rkf-events-1.0.0";

export const DOMAIN_EVENT_CONTRACTS: DomainEventContract[] = [
  { name: "athlete.created", version: "v1", actor: "coach", payload: ["athleteId", "organizationId"] },
  { name: "athlete.updated", version: "v1", actor: "coach", payload: ["athleteId", "changedFields"] },
  { name: "athlete.anonymized", version: "v1", actor: "admin", payload: ["athleteId", "requestedBy", "lgpdBasis"] },
  { name: "session.library.viewed", version: "v1", actor: "coach", payload: ["sessionId"] },
  { name: "session.prescription.composed", version: "v1", actor: "system", payload: ["athleteId", "volumeM", "primaryZone"] },
  { name: "session.prescription.saved", version: "v1", actor: "coach", payload: ["prescriptionId", "version"] },
  { name: "session.prescription.approved", version: "v1", actor: "coach", payload: ["prescriptionId", "approvedBy"] },
  { name: "session.prescription.published", version: "v1", actor: "coach", payload: ["prescriptionId", "targetType", "targetId"] },
  { name: "session.prescription.pdf.exported", version: "v1", actor: "coach", payload: ["prescriptionId"] },
  { name: "cycle.generated", version: "v1", actor: "coach", payload: ["athleteId", "model", "totalWeeks"] },
  { name: "training.ingestion.received", version: "v1", actor: "coach", payload: ["ingestionId", "channel"] },
  { name: "training.ingestion.stored", version: "v1", actor: "system", payload: ["ingestionId", "sha256"] },
  { name: "training.ingestion.extracted", version: "v1", actor: "system", payload: ["ingestionId", "format"] },
  { name: "training.ingestion.parsed", version: "v1", actor: "system", payload: ["ingestionId", "blocks"] },
  { name: "training.ingestion.reviewed", version: "v1", actor: "coach", payload: ["ingestionId", "reviewer"] },
  { name: "training.ingestion.corrected", version: "v1", actor: "coach", payload: ["ingestionId", "version"] },
  { name: "training.ingestion.confirmed", version: "v1", actor: "coach", payload: ["ingestionId", "confirmedBy"] },
  { name: "training.ingestion.assigned", version: "v1", actor: "coach", payload: ["ingestionId", "targetType"] },
  { name: "training.ingestion.committed", version: "v1", actor: "system", payload: ["ingestionId", "fromState", "toState"] },
  { name: "training.ingestion.failed", version: "v1", actor: "system", payload: ["ingestionId", "reason"] },
  { name: "video.track.assignment.recorded", version: "v1", actor: "coach", payload: ["videoId", "trackId", "organizationId", "assignmentId"] },
  { name: "session.executed", version: "v1", actor: "athlete", payload: ["athleteId", "date", "durationMinutes"] },
  { name: "session.result.recorded", version: "v1", actor: "athlete", payload: ["athleteId", "resultId"] },
  { name: "load.layers.calculated", version: "v1", actor: "system", payload: ["athleteId", "internalLoadUa"] },
  { name: "load.snapshot.committed", version: "v1", actor: "system", payload: ["athleteId", "snapshotId"] },
  { name: "readiness.assessed", version: "v1", actor: "system", payload: ["athleteId", "readiness"] },
  { name: "adaptation.decided", version: "v1", actor: "system", payload: ["athleteId", "class"] },
  { name: "evolution.assessed", version: "v1", actor: "system", payload: ["athleteId", "classification"] },
  { name: "response.index.calculated", version: "v1", actor: "system", payload: ["athleteId", "responseScore"] },
  { name: "user.login", version: "v1", actor: "system", payload: ["userId"] },
  { name: "user.logout", version: "v1", actor: "system", payload: ["userId"] },
  { name: "user.login_failed", version: "v1", actor: "system", payload: ["identifier"] },
  { name: "governance.decision.versioned", version: "v1", actor: "admin", payload: ["decisionId", "version"] },
  { name: "seed.imported", version: "v1", actor: "coach", payload: ["importId", "packageHash", "rows"] },
  { name: "seed.staged", version: "v1", actor: "coach", payload: ["packageHash"] },
  { name: "backup.created", version: "v1", actor: "admin", payload: ["backupId", "checksum"] },
  { name: "backup.restored", version: "v1", actor: "admin", payload: ["backupId", "restoredBy"] },
];

/** Valida uma carga contra o contrato mínimo do evento; falha descreve campos ausentes. */
export function validateEventPayload(name: DomainEventName, payload: Record<string, unknown>): { valid: boolean; missing: string[] } {
  const contract = DOMAIN_EVENT_CONTRACTS.find((event) => event.name === name);
  if (!contract) return { valid: false, missing: [`contrato inexistente para ${name}`] };
  const missing = contract.payload.filter((field) => payload[field] === undefined || payload[field] === null || payload[field] === "");
  return { valid: missing.length === 0, missing };
}
