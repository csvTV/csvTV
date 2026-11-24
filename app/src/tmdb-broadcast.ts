import type { BroadcastSeason } from './broadcast-seasons.ts';
import type { TmdbShow } from './tmdb-data.ts';

function object(value: unknown): Record<string,unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined;
}
const integer = (value:unknown, min:number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

/** Ignore DVD cuts, chronology, story arcs and cours. A TV order must explicitly describe seasons. */
export function broadcastCandidates(raw:unknown) {
  const groups = object(object(raw)?.episode_groups)?.results;
  const ids = new Set<string>();
  if (!Array.isArray(groups)) return [];
  for (const item of groups) {
    const g = object(item);
    if (!g || (g.type !== 1 && !(g.type === 7 && typeof g.name === 'string' &&
      /^(?:seasons?|broadcast seasons?|tv seasons?|剧集|劇集|シーズン)$/i.test(g.name.trim())))) continue;
    if (typeof g.id === 'string' && /^[a-f\d]{24}$/.test(g.id) && integer(g.group_count,2)) ids.add(g.id);
  }
  // If many incompatible editorial orders are advertised, leave the choice with the owner.
  return ids.size <= 3 ? [...ids] : [];
}

function seasonLabel(value:unknown): number | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFKC').trim();
  const match = /^(?:season|series|saison|temporada|staffel|シーズン)\s*(\d+)(?:$|[\s:–—-])/i.exec(name)
    ?? /^第\s*(\d+)\s*(?:季|期)/.exec(name);
  return match && integer(Number(match[1]),1) ? Number(match[1]) : null;
}

/** Accept an identity-preserving split. A repeated ID, missing slot or changed order invalidates the candidate. */
export function readBroadcastOrder(raw:unknown, id:string, show:TmdbShow): BroadcastSeason[] | null {
  const detail = object(raw);
  if (!detail || detail.id !== id || (detail.type !== 1 && detail.type !== 7) || !Array.isArray(detail.groups)) return null;
  const sizes = new Map(show.seasons.filter(s=>s.season>0 && s.episodeCount>0).map(s=>[s.season,s.episodeCount]));
  const expected = [...sizes.keys()].sort((a,b)=>a-b);
  const seen = new Set<number>(), result:BroadcastSeason[] = [];
  for (const item of detail.groups) {
    const group = object(item);
    if (!group || !Array.isArray(group.episodes)) return null;
    const regular:{order:number; season:number; episode:number}[] = [];
    for (const item of group.episodes) {
      const e = object(item);
      if (!e || e.show_id !== show.show_id || !integer(e.id,1) || seen.has(e.id) ||
          !integer(e.season_number,0) || !integer(e.episode_number,1) || !integer(e.order,0)) return null;
      seen.add(e.id);
      if (e.season_number>0) regular.push({order:e.order,season:e.season_number,episode:e.episode_number});
    }
    if (!regular.length) continue;
    const number = seasonLabel(group.name);
    if (!number) return null;
    regular.sort((a,b)=>a.order-b.order);
    const first = regular[0], sourceSeason = first.season;
    if (!sizes.has(sourceSeason) || regular.some((e,i)=> e.season!==sourceSeason || e.episode!==first.episode+i ||
      (i>0 && e.order===regular[i-1].order))) return null;
    result.push({number,sourceSeason,first:first.episode,last:regular[regular.length-1].episode});
  }
  result.sort((a,b)=>a.number-b.number);
  let current = 0, next = 1;
  for (const [index,r] of result.entries()) {
    if (r.number !== index+1 || r.sourceSeason !== expected[current] || r.first !== next || r.last > sizes.get(r.sourceSeason)!) return null;
    next = r.last+1;
    if (r.last === sizes.get(r.sourceSeason)) {current++; next=1;}
  }
  // A group can lag one or more newly listed episodes. Its verified prefix remains usable.
  // The projection explicitly identifies any remaining native episodes as unassigned.
  return new Set(result.map(r=>r.sourceSeason)).size < result.length ? result : null;
}

/** Tie a reusable last-good lookup to the same group IDs and TMDB season identities. */
export function broadcastSource(raw:unknown, ids:string[]): string | undefined {
  const seasons = object(raw)?.seasons;
  if (!ids.length || !Array.isArray(seasons)) return;
  const parts = seasons.map(object).filter(s=>s?.season_number!==0);
  if (!parts.every(s=>s && integer(s.season_number,1) && integer(s.id,1))) return;
  return JSON.stringify([ids.slice().sort(),parts.map(s=>[s!.season_number,s!.id]).sort(([a],[b])=>Number(a)-Number(b))]);
}
