/**
 * Chart palette (dark surface). A plain module, not `'use client'`: a server component that
 * imports a constant from a client module gets a client reference, not the value.
 */
export const CHART_SURFACE = '#12161b';
export const CHART_GRID = '#2c2c2a';
export const CHART_MUTED = '#898781';
export const CHART_SECONDARY = '#c3c2b7';
/** Categorical order, never cycled: blue, then orange (validated for CVD on the dark surface). */
export const SERIES_COLORS = ['#3987e5', '#d95926'] as const;
