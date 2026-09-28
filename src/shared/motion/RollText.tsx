/**
 * E2: the label rolls up to a second copy on hover (mouse only, see motion.css). The copy is
 * aria-hidden and not rendered on touch screens. `children` always comes from i18n.
 */
export function RollText({ children }: { children: string }) {
  return (
    <span className="roll">
      <span>{children}</span>
      <span aria-hidden="true">{children}</span>
    </span>
  )
}
