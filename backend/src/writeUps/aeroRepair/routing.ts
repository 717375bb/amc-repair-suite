import { AERO_REPAIR_ROUTING } from './constants.js';

export type RoutingResult =
  | { status: 'routed'; stationCode: string; location: string }
  | { status: 'exception'; stationCode: string };

/**
 * Station code -> Aero Repair location. A station outside the 12 known ones
 * is an explicit exception — never guessed at, never defaulted to any
 * location, per the task's own requirement. Callers must branch on
 * `status`, not assume `routed`.
 */
export function routeStationToAeroRepairLocation(stationCode: string): RoutingResult {
  const normalized = stationCode.trim().toUpperCase();
  const location = AERO_REPAIR_ROUTING[normalized];
  if (!location) {
    return { status: 'exception', stationCode: normalized };
  }
  return { status: 'routed', stationCode: normalized, location };
}
