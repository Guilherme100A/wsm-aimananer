// Cores dos gráficos (recharts) lidas dos tokens CSS, para acompanhar o tema claro/escuro.
import { useSyncExternalStore } from 'react'
import { getTheme, subscribeTheme, type Theme } from './theme'

export interface ChartColors {
  sent: string
  received: string
  failed: string
  warning: string
  accent: string
  neutral: string
  grid: string
  axis: string
  tooltipBg: string
  tooltipBorder: string
  text: string
}

const TOKENS: Record<keyof ChartColors, string> = {
  sent: '--chart-sent',
  received: '--chart-received',
  failed: '--danger',
  warning: '--warning',
  accent: '--accent',
  neutral: '--chart-neutral',
  grid: '--border',
  axis: '--text-muted',
  tooltipBg: '--surface-2',
  tooltipBorder: '--border-strong',
  text: '--text',
}

const cache = new Map<Theme, ChartColors>()

function read(theme: Theme): ChartColors {
  const hit = cache.get(theme)
  if (hit) return hit
  const style = getComputedStyle(document.documentElement)
  let complete = true
  const colors = Object.fromEntries(
    Object.entries(TOKENS).map(([k, token]) => {
      const value = style.getPropertyValue(token).trim()
      if (!value) complete = false
      return [k, value || 'currentColor']
    }),
  ) as unknown as ChartColors
  // CSS ainda não carregado (dev): não guarda o fallback.
  if (complete) cache.set(theme, colors)
  return colors
}

export function useChartColors(): ChartColors {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'light' as Theme)
  return read(theme)
}

const reduceQuery = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined)

/** Animações do recharts são JS (não CSS): desliga quando o usuário pede menos movimento. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = reduceQuery()
      q?.addEventListener('change', cb)
      return () => q?.removeEventListener('change', cb)
    },
    () => !!reduceQuery()?.matches,
    () => false,
  )
}
