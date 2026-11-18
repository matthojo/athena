/**
 * The car for the app (GET /api/car, netlify/lib/car-routes.ts): one card per
 * vehicle and whether each key is set up. Nothing is cached on the device:
 * registrations stay on Athena's server. Sample mode answers from the sample
 * car (lib/car-sync.ts sampleVehicle) and keeps changes on this page.
 */
import { isSampleMode, request } from "./api";
import { carCard, normaliseRegistration, type CarCard, type CarVehicle } from "../../../lib/car";
import { sampleVehicle } from "../../../lib/car-sync";

export type { CarCard } from "../../../lib/car";

export interface CarView {
  vehicles: CarCard[];
  keys: { dvla: boolean; mot: boolean };
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let sample: CarVehicle[] | null = null;
const sampleView = (): CarView => {
  sample ??= [sampleVehicle(today())];
  return { vehicles: sample.map((v) => carCard(v, today())), keys: { dvla: true, mot: true } };
};

export async function fetchCar(): Promise<CarView> {
  if (isSampleMode()) return sampleView();
  return request<CarView>("/car");
}

export async function addCar(registration: string): Promise<CarView & { id: string }> {
  if (isSampleMode()) {
    const reg = normaliseRegistration(registration);
    if (!reg) throw new Error("That doesn't look like a registration number. Type it as it is on the plate, like AB12 CDE.");
    const v: CarVehicle = { ...sampleVehicle(today()), id: `sample-${reg}`, registration: reg };
    sample = [...(sample ?? []).filter((x) => x.registration !== reg), v];
    return { ...sampleView(), id: v.id };
  }
  return request("/car/vehicles", { method: "POST", body: JSON.stringify({ registration }) });
}

export async function removeCar(id: string): Promise<CarView> {
  if (isSampleMode()) {
    sample = (sample ?? []).filter((v) => v.id !== id);
    return sampleView();
  }
  return request(`/car/vehicles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function refreshCar(): Promise<CarView> {
  if (isSampleMode()) return sampleView();
  return request("/car/refresh", { method: "POST" });
}
