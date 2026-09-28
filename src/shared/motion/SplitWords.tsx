import { Fragment } from 'react'
import { useInView } from './useInView'

type HeadingTag = 'h1' | 'h2' | 'h3'

/**
 * E5: a title that rises word by word (per word, never per letter). The words are aria-hidden;
 * a heading carries the whole text in `aria-label`, other elements in a visually hidden copy
 * (aria-label is not allowed on a plain span), so screen readers read one sentence.
 * `text` always comes from i18n or from data (a business name), never a literal.
 */
export function SplitWords({
  text,
  as: Tag = 'span',
  className,
}: {
  text: string
  as?: HeadingTag | 'span' | 'p'
  className?: string
}) {
  const { ref, inView } = useInView<HTMLElement>()
  const words = text.trim().split(/\s+/)
  const heading = Tag === 'h1' || Tag === 'h2' || Tag === 'h3'

  return (
    <Tag
      ref={ref}
      className={className}
      data-inview={inView}
      aria-label={heading ? text : undefined}
    >
      {!heading && <span className="visually-hidden">{text}</span>}
      {words.map((word, index) => (
        <Fragment key={index}>
          {index > 0 && ' '}
          <span aria-hidden="true" className="split-word" style={{ '--i': index }}>
            {word}
          </span>
        </Fragment>
      ))}
    </Tag>
  )
}
