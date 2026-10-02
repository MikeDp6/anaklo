/** Which way a screen of a flow was entered: from the step before, from the one after, or not. */
export type StepDirection = 'forward' | 'back' | null

/**
 * E14 (MOTION.md, `motion.css`) for a step change of the enrolment wizard and the entry into
 * «Πρόσθεσε δεύτερη συσκευή» (contract 1.7 §6.12): forward from the right, back from the left;
 * nothing on a first screen and nothing at all with reduced motion (the content is simply there;
 * motion.css's reduced-motion block is the second line).
 */
export function stepMotionClass(direction: StepDirection, reduced: boolean): string | null {
  if (reduced) return null
  if (direction === 'forward') return 'step-enter'
  if (direction === 'back') return 'step-enter-back'
  return null
}
