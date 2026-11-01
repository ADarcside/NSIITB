/**
 * Namma Space: POI search (Round 2)
 * Small, dependency-free ranking over name, aliases and category. Handles case, punctuation,
 * word order ("room 4 meeting"), prefixes ("meet"), digits written as words ("four"), and
 * one typo per word ("meting room", "dor").
 */

import type { POI } from '../contracts/types.js';

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

/** Lowercase words with punctuation removed and number words as digits. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(t => NUMBER_WORDS[t] ?? t);
}

/** Levenshtein distance, stopping early once it exceeds max. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How well one query word matches one target word: 1 exact, less for prefix / typo, 0 none. */
function wordScore(q: string, t: string): number {
  if (q === t) return 1;
  // Digits must match exactly: "Room 4" is not "Room 14"
  if (/^\d+$/.test(q) || /^\d+$/.test(t)) return 0;
  if (t.startsWith(q)) return q.length >= 2 ? 0.8 : 0.4;
  if (q.length >= 4 && editDistance(q, t, 1) <= 1) return 0.7;
  // Short words: one typo, same first letter ("dor" finds "door", "bot" doesn't find "top")
  if (q.length === 3 && q[0] === t[0] && editDistance(q, t, 1) <= 1) return 0.6;
  if (q.length >= 7 && editDistance(q, t, 2) <= 2) return 0.55;
  return 0;
}

/** Score of query words against one field's words: every query word must match something. */
function fieldScore(qs: string[], ts: string[]): number {
  if (!ts.length) return 0;
  let sum = 0;
  for (const q of qs) {
    let best = 0;
    for (const t of ts) best = Math.max(best, wordScore(q, t));
    if (best === 0) return 0;
    sum += best;
  }
  // Prefer fields with fewer extra words ("Room 4" over "Room 4 store cupboard")
  const coverage = qs.length / Math.max(qs.length, ts.length);
  return (sum / qs.length) * (0.85 + 0.15 * coverage);
}

export interface SearchHit {
  poi: POI;
  score: number;
}

/** POIs matching the query, best first. An empty query lists all POIs by name. */
export function searchPois(pois: POI[], query: string, limit = 8): SearchHit[] {
  const qs = tokens(query);
  if (!qs.length) {
    return [...pois].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit).map(poi => ({ poi, score: 0 }));
  }
  const hits: SearchHit[] = [];
  for (const poi of pois) {
    const name = fieldScore(qs, tokens(poi.name));
    const alias = Math.max(0, ...(poi.aliases ?? []).map(a => fieldScore(qs, tokens(a)) * 0.95));
    const cat = poi.category ? fieldScore(qs, tokens(poi.category)) * 0.6 : 0;
    const desc = poi.description ? fieldScore(qs, tokens(poi.description)) * 0.5 : 0;
    const score = Math.max(name, alias, cat, desc);
    if (score > 0) hits.push({ poi, score });
  }
  hits.sort((a, b) => b.score - a.score || a.poi.name.localeCompare(b.poi.name));
  return hits.slice(0, limit);
}
