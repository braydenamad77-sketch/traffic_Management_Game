import { LevelDefinition, LevelObjective } from './levelKit';
import { SimStats } from './sim';

export type ObjectiveStatus = 'custom' | 'running' | 'won' | 'failed';

export interface ObjectiveRun {
  level: LevelDefinition | null;
  objective: LevelObjective | null;
  startArrivals: number;
  progress: number;
  gridlockEvents: number;
  status: ObjectiveStatus;
}

export function createObjectiveRun(level: LevelDefinition | null, arrived = 0): ObjectiveRun {
  const objective = level?.campaign?.objective ?? null;
  return {
    level,
    objective,
    startArrivals: arrived,
    progress: 0,
    gridlockEvents: 0,
    status: objective ? 'running' : 'custom',
  };
}

export function resetObjectiveRun(run: ObjectiveRun, arrived = 0): ObjectiveRun {
  return createObjectiveRun(run.level, arrived);
}

export function updateObjectiveRun(run: ObjectiveRun, stats: SimStats): ObjectiveRun {
  if (!run.objective || run.status === 'won' || run.status === 'failed') return run;
  const gridlockEvents = run.gridlockEvents + (stats.gridlocked ? 1 : 0);
  const progress = Math.max(0, stats.arrived - run.startArrivals);
  const status = gridlockEvents > run.objective.maxGridlockEvents
    ? 'failed'
    : progress >= run.objective.targetArrivals ? 'won' : 'running';
  return { ...run, progress, gridlockEvents, status };
}
