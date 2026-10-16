export interface RunExperienceView {
  activities: Record<string, unknown>[]
  plans: Record<string, unknown>[]
  toolProgress: Record<string, unknown>[]
  notices: Record<string, unknown>[]
}

export function emptyExperience(): RunExperienceView {
  return { activities: [], plans: [], toolProgress: [], notices: [] }
}

export function experienceSnapshot(value: unknown): RunExperienceView {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const result = emptyExperience()
  for (const key of Object.keys(result) as (keyof RunExperienceView)[]) {
    result[key] = Array.isArray(source[key]) ? source[key].filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))) : []
  }
  return result
}

export function applyExperience(current: RunExperienceView | undefined, type: string, payload: Record<string, unknown>): RunExperienceView {
  const state = current ?? emptyExperience()
  const route = {
    'activity.upsert': ['activities', 'activityId'],
    'plan.upsert': ['plans', 'planId'],
    'tool.progress': ['toolProgress', 'id'],
    'notice.upsert': ['notices', 'noticeId'],
  }[type] as [keyof RunExperienceView, string] | undefined
  if (!route || typeof payload[route[1]] !== 'string') return state
  const [collection, idKey] = route
  const previous = state[collection].find(entry => entry[idKey] === payload[idKey])
  if (previous && Number(previous.lastSourceSeq) >= Number(payload.lastSourceSeq)) return state
  if (collection === 'plans' && previous && Number(previous.revision) >= Number(payload.revision)) return state
  return { ...state, [collection]: [...state[collection].filter(entry => entry[idKey] !== payload[idKey]), payload] }
}

export function settleExperience(current: RunExperienceView | undefined, status: string): RunExperienceView {
  const state = current ?? emptyExperience()
  return { ...state, activities: state.activities.map(activity => activity.status === 'running' ? { ...activity, status } : activity) }
}
