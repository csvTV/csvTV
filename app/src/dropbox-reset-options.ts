export const resetLabels = {
  watched:'Watch history and recent marks', ratings:'Ratings', lists:'Lists and Watchlist',
  settings:'Settings and API keys', backups:'Backups',
} as const;
export type ResetScope = keyof typeof resetLabels;
