export interface CriticScores { tomatoes: number | null; metacritic: number | null; myanimelist: number | null }
export interface ScoreEntry { fetchedAt: number; scores: CriticScores }
export interface MdbListPause { kind: 'refused' | 'throttled'; until: number; message: string }
export interface MdbListControl { generation: bigint; pause: MdbListPause | null }
export interface MdbListState extends MdbListControl {
  key: string | null;
  malSource: 'mdblist' | 'github';
  revision: bigint;
  entries: Map<number, ScoreEntry>;
}
export interface MdbListWrite { entries?: Map<number, ScoreEntry>; pause?: MdbListPause | null }
export const mdbListControlKey = 'mdblist-control';
export const scoreKey = (id: number): IDBValidKey => ['mdblist', id];
export const mdbListControl = (stored?: MdbListControl): MdbListControl => stored ?? { generation: 0n, pause: null };
export const quotaKey = (hash: string): IDBValidKey => ['mdblist-quota', hash];
