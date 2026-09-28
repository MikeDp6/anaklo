import 'react'

// Lets `style` set CSS custom properties with type checking (`style={{ '--i': 2 }}`).
declare module 'react' {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined
  }
}
