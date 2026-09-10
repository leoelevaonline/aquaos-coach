import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkoutComposer } from "../modals";
import { Practices } from "../views-primary";
import { apiRequest } from "../api";

vi.mock("../api", () => ({
  API_URL: "http://localhost:4000",
  apiRequest: vi.fn(),
  importFile: vi.fn(),
  mediaUrl: vi.fn(),
  subscribeToLiveEvents: vi.fn(() => () => undefined),
  uploadFile: vi.fn(),
}));

const mockedApi = vi.mocked(apiRequest);

describe("agenda de treinos", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T12:00:00-03:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("repassa o dia selecionado ao editor", async () => {
    mockedApi.mockResolvedValue({ data: [] });
    const onCreate = vi.fn();
    render(<Practices onCreate={onCreate} onNotify={() => undefined} />);
    const button = await screen.findByRole("button", { name: "Planejar QUI, 03 de setembro" });
    fireEvent.click(button);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: "2026-09-03T08:00" }));
  });

  it("publica usando a data recebida da agenda", async () => {
    mockedApi.mockResolvedValue({ id: "workout-test", date: "2026-09-03" });
    const onSave = vi.fn();
    const { container } = render(<WorkoutComposer seed={{ title: "Sessão de quinta", prompt: "", distanceMeters: 0, zone: "A1", kind: "swim", scheduledAt: "2026-09-03T08:00" }} onClose={() => undefined} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Volume total (m)"), { target: { value: "4200" } });
    fireEvent.change(container.querySelector(".composer-input textarea")!, { target: { value: "Aquecimento 800 m\nSérie principal 12x200 A2\nSoltura 400 m" } });
    fireEvent.click(screen.getByRole("button", { name: /Estruturar treino/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByRole("button", { name: /Publicar em 03\/09.*08:00/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Publicar em 03\/09.*08:00/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [, options] = mockedApi.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ date: "2026-09-03", scheduledAt: "2026-09-03T08:00", distanceMeters: 4200 });
  });

  it("navega por dias sem esvaziar a agenda e preserva a data ao criar", async () => {
    mockedApi.mockResolvedValue({ data: [] });
    const onCreate = vi.fn();
    const { container } = render(<Practices onCreate={onCreate} onNotify={() => undefined} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Dia", exact: true })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Próximo dia", exact: true }));
    expect(container.querySelectorAll(".day-column")).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "Planejar QUA, 02 de setembro" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: "2026-09-02T08:00" }));
    fireEvent.click(screen.getByRole("button", { name: "Dia anterior", exact: true }));
    expect(await screen.findByRole("button", { name: "Planejar TER, 01 de setembro" })).toBeInTheDocument();
  });
});
