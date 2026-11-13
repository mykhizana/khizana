// Where the archive lives: in this browser only (device mode) or in the owner's Supabase (cloud mode).
export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || ''
export const SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || ''
export const MODE: 'local' | 'cloud' = SUPABASE_URL && SUPABASE_KEY ? 'cloud' : 'local'
export const BASE = import.meta.env.BASE_URL

export const MODEL = 'claude-opus-5-5'
export const APP_VERSION = '1.0.0'

// pages sent to the AI: long edge in pixels (Arabic small print stays readable)
export const OCR_EDGE = 1600
// pages kept for viewing
export const PAGE_EDGE = 2200
export const THUMB_EDGE = 420
