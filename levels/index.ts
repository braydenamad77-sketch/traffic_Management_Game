import bridgeRiver from './bridge-river';
import { CAMPAIGN_LEVELS } from './campaign';
import fourWaySignal from './four-way-signal';
import multiLaneMerge from './multi-lane-merge';
import oneWayRoundabout from './one-way-roundabout';
import simpleTwoGate from './simple-two-gate';
import tightCurveStress from './tight-curve-stress';

export { CAMPAIGN_LEVELS };

export const LEVELS = [
  ...CAMPAIGN_LEVELS,
  simpleTwoGate,
  fourWaySignal,
  tightCurveStress,
  bridgeRiver,
  multiLaneMerge,
  oneWayRoundabout,
];

export function findLevel(id: string) {
  return LEVELS.find(level => level.id === id);
}
