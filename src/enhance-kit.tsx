/**
 * enhance-kit — shared theme, components, and chart utilities for .tsx enhancer files.
 *
 * Every enhancer widget should import from '@enhance-kit' instead of defining
 * its own colors, tokens, or base ECharts options. This guarantees that
 * light/dark mode works automatically and colors stay consistent.
 */

import { useState, useSyncExternalStore } from 'react'
import _ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import {
  BarChart, RadarChart, LineChart, PieChart, HeatmapChart,
} from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent,
  RadarComponent, VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

// Register once — importers don't need to repeat this.
echarts.use([
  BarChart, RadarChart, LineChart, PieChart, HeatmapChart,
  GridComponent, TooltipComponent, LegendComponent,
  RadarComponent, VisualMapComponent, CanvasRenderer,
])

// Re-export so enhancers only need one import source.
export { echarts }

// ─── Theme subscription (useSyncExternalStore) ───
// Provides tear-free, synchronous reads of data-theme so charts and widgets
// never render with stale theme values.

function subscribeTheme(callback: () => void) {
  const observer = new MutationObserver(callback)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  return () => observer.disconnect()
}

function getIsDarkSnapshot() {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

function getThemeKeySnapshot() {
  return document.documentElement.getAttribute('data-theme') || 'light'
}

// Themed wrapper — forces full React unmount/remount when dark ↔ light toggles.
// echarts-for-react uses async init internally (renderNewEcharts is a Promise chain)
// which races with React renders. A key change is synchronous and reliable.
export function ReactEChartsCore(
  props: React.ComponentProps<typeof _ReactEChartsCore>
) {
  const themeKey = useSyncExternalStore(subscribeTheme, getThemeKeySnapshot)
  return <_ReactEChartsCore key={themeKey} {...props} notMerge />
}

// ─── CSS Variable Bridge ───
// ECharts renders on <canvas> and cannot resolve CSS variables.
// We read the computed values from the DOM so charts get real hex colors.

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

// ─── Theme Hook ───

export interface Theme {
  isDark: boolean
  bg: string
  bgSub: string
  bgHover: string
  text: string
  textSec: string
  textMut: string
  accent: string
  accentLight: string
  border: string
  borderLight: string
  shadow: string
  palette: string[]
  radius: number
  font: string
  fontDisplay: string
  fontMono: string
}

export function useTheme(): Theme {
  const isDark = useSyncExternalStore(subscribeTheme, getIsDarkSnapshot)

  // Every render after a theme change re-reads computed CSS values.
  const d = isDark
  return {
    isDark: d,
    bg:          cssVar('--bg-card',       d ? '#22211E' : '#FAF7F2'),
    bgSub:       cssVar('--bg-secondary',  d ? '#1C1B19' : '#F5F0E8'),
    bgHover:     cssVar('--bg-hover',      d ? '#2A2924' : '#F0EBE2'),
    text:        cssVar('--text-primary',   d ? '#D5D0C8' : '#2D2B28'),
    textSec:     cssVar('--text-secondary', d ? '#ADA89E' : '#5A5650'),
    textMut:     cssVar('--text-muted',     d ? '#5C5850' : '#ADA89F'),
    accent:      cssVar('--accent',         d ? '#7AB06E' : '#2D5A27'),
    accentLight: cssVar('--accent-light',   d ? '#2A3328' : '#E8F0E6'),
    border:      cssVar('--border',         d ? '#35342F' : '#DDD8CE'),
    borderLight: cssVar('--border-light',   d ? '#2E2D28' : '#E8E3DA'),
    shadow: d
      ? '0 1px 3px rgba(0,0,0,0.15), 0 4px 12px rgba(0,0,0,0.25)'
      : '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03)',
    palette: [
      cssVar('--chart-1', d ? '#7AB89A' : '#5B8A72'),
      cssVar('--chart-2', d ? '#94BDD8' : '#7BA7C9'),
      cssVar('--chart-3', d ? '#D4BA85' : '#C4A46D'),
      cssVar('--chart-4', d ? '#D89B94' : '#C9827A'),
      cssVar('--chart-5', d ? '#B3A8D6' : '#9B8EC4'),
      cssVar('--chart-6', d ? '#A8B5A3' : '#8E9E8A'),
    ],
    radius: 12,
    font:        "'Inter', system-ui, sans-serif",
    fontDisplay: "'Space Grotesk', system-ui, sans-serif",
    fontMono:    "'JetBrains Mono', monospace",
  }
}

// ─── ECharts Base Option ───

export function useBaseOption(t: Theme) {
  return {
    textStyle: { fontFamily: t.font, color: t.textSec, fontSize: 12 },
    tooltip: {
      backgroundColor: t.bg,
      borderColor: t.border,
      borderWidth: 1,
      textStyle: { fontFamily: t.font, fontSize: 12, color: t.text },
      extraCssText: `border-radius:${t.radius}px;box-shadow:${t.shadow};padding:8px 14px`,
    },
    legend: { textStyle: { fontFamily: t.font, fontSize: 11, color: t.textSec } },
    grid: { containLabel: true },
    color: t.palette,
    animationDuration: 600,
    animationEasing: 'cubicOut' as const,
  }
}

// ─── Shared Components ───

export function WidgetHeader({ title, subtitle, t }: {
  title: string; subtitle?: string; t: Theme
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        fontSize: 11, fontFamily: t.fontMono, fontWeight: 500,
        color: t.accent, letterSpacing: '0.08em', textTransform: 'uppercase',
        marginBottom: 4,
      }}>Interactive</div>
      <div style={{
        fontSize: 17, fontWeight: 600, fontFamily: t.fontDisplay,
        color: t.text, lineHeight: 1.3,
      }}>{title}</div>
      {subtitle && (
        <div style={{
          fontSize: 13, color: t.textMut, marginTop: 4, lineHeight: 1.4,
        }}>{subtitle}</div>
      )}
    </div>
  )
}

export function WidgetNote({ text, t }: { text: string; t: Theme }) {
  return (
    <div style={{
      fontSize: 12, color: t.textSec, marginTop: 12, lineHeight: 1.6,
    }}>{text}</div>
  )
}

export function Pill({ label, active, color, onClick }: {
  label: string; active: boolean; color: string; onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '5px 14px', fontSize: 12,
        fontFamily: "'Inter', system-ui, sans-serif",
        fontWeight: active ? 600 : 400, border: 'none', borderRadius: 8,
        background: active ? color : hovered ? `${color}10` : 'transparent',
        color: active ? '#fff' : color, cursor: 'pointer',
        transition: 'all 180ms ease',
        outline: active ? 'none' : `1px solid ${hovered ? color : `${color}30`}`,
        outlineOffset: -1,
      }}
    >{label}</button>
  )
}
