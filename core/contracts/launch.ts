/**
 * `GET /api/office/launch`: the owner's setup checklist, "what is left so the farm earns by
 * itself". Every value is detected from existing tables and the environment and reduced to
 * booleans, counts and server codes: no key, address, token or password ever leaves the server.
 * Test modes (training, Demo, sandbox, Sepolia) are named as tests and never counted as income.
 */

/**
 * done: works; needed: the owner has to act; blocked: waits for another step first;
 * optional: not required for autonomous income and not done.
 */
export type LaunchStepStatus = 'done' | 'needed' | 'blocked' | 'optional'

/** Order of the groups is the order of value: what unlocks income first comes first. */
export type LaunchGroup = 'required' | 'freelance' | 'payments' | 'trading' | 'extra'

export type LaunchStep = {
  id: string
  group: LaunchGroup
  status: LaunchStepStatus
  /** Counted in the readiness score; optional steps are not. */
  required: boolean
  /** Plain Russian name, no jargon. */
  title: string
  /** What income or capability this unlocks. */
  why: string
  /** What the owner does, short imperative steps. */
  actions: string[]
  /** Office page where it is done, with a hash when the page has a matching section. */
  link: string | null
  linkLabel: string
  /** The detected state in plain words, including a human-readable last error if any. */
  state: string
  /** Server codes behind the state, for the technical log; may be empty. */
  codes: string[]
}

export type LaunchView = {
  generatedAt: string
  /** Required steps that are done, and the number of required steps. */
  done: number
  total: number
  /** The most valuable thing the owner can do right now; null when every required step is done. */
  next: LaunchStep | null
  groups: { id: LaunchGroup; title: string; hint: string; steps: LaunchStep[] }[]
}
