import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrackAssignmentPanel } from "../track-assignment";

const apiRequest = vi.fn();
vi.mock("../api", () => ({ apiRequest: (...args: unknown[]) => apiRequest(...args) }));

describe("TrackAssignmentPanel", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({
      assignments: [{ id: "assignment-1", trackId: "7", athleteId: "ana-souza", reason: "Conferido", actorName: "Marcos Costa", createdAt: "2026-09-01T10:00:00Z" }],
      currentByTrack: { "7": { id: "assignment-1", trackId: "7", athleteId: "ana-souza", reason: "Conferido", actorName: "Marcos Costa", createdAt: "2026-09-01T10:00:00Z" } },
      athletes: [{ id: "ana-souza", name: "Ana Souza" }, { id: "caio-martins", name: "Caio Martins" }],
    });
  });

  it("mostra o track técnico separado e registra uma correção humana", async () => {
    render(<TrackAssignmentPanel videoId="video-1" trackIds={["7"]} />);
    expect(await screen.findByText("Track técnico #7")).toBeInTheDocument();
    expect(screen.getByText(/Nenhuma pessoa é reconhecida automaticamente/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Atleta nominal para track 7" }), { target: { value: "caio-martins" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Motivo para track 7" }), { target: { value: "Correção após revisão do treinador" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar versão" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/v1/videos/video-1/tracks/7/assignments", expect.objectContaining({ method: "POST" })));
    const [, request] = apiRequest.mock.calls.find(([path]) => path.includes("/assignments")) as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({ athleteId: "caio-martins", reason: "Correção após revisão do treinador" });
  });
});
