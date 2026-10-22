import type { Plan } from "./db/schema.ts";

export interface PlanLimits {
  id: Plan;
  name: string;
  priceMonthlyUsd: number;
  seats: number;
  cloudProjects: number;
  storageBytes: number;
  exportSecondsPerMonth: number;
  aiSecondsPerMonth: number;
  maxExportHeight: number;
}

const GB = 1024 ** 3;
/** Local editing, local AI and local exports are always free and unlimited; plans meter cloud resources only. */
export const PLANS: PlanLimits[] = [
  { id: "free", name: "Free", priceMonthlyUsd: 0, seats: 1, cloudProjects: 3, storageBytes: 2 * GB, exportSecondsPerMonth: 4 * 3600, aiSecondsPerMonth: 30 * 60, maxExportHeight: 2160 },
  { id: "pro", name: "Pro", priceMonthlyUsd: 12, seats: 1, cloudProjects: 100, storageBytes: 100 * GB, exportSecondsPerMonth: 100 * 3600, aiSecondsPerMonth: 20 * 3600, maxExportHeight: 4320 },
  { id: "team", name: "Team", priceMonthlyUsd: 29, seats: 10, cloudProjects: 1000, storageBytes: 1024 * GB, exportSecondsPerMonth: 1000 * 3600, aiSecondsPerMonth: 200 * 3600, maxExportHeight: 4320 },
];
export const planFor = (p: Plan) => PLANS.find((x) => x.id === p) ?? PLANS[0]!;
