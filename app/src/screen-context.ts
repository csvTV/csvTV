import type { TmdbService } from './tmdb-service.ts';
import type { MdbListService } from './mdblist-service.ts';
import type { ImdbService } from './imdb-service.ts';
import type { MalService } from './mal-service.ts';
import type { WatchActions } from './watch-actions.ts';
import type { LibraryPreferences } from './library-screen.ts';

export type Route = { page: 'home' | 'settings' | 'imdb-ratings' | 'mal-scores' | 'lists' | 'library' | 'ratings' | 'statistics' | 'export' | 'recovery' | 'hand-merge' | 'trakt-import' | 'anilist-import' }
  | { page: 'watchlist'; section?: 'more-to-watch' }
  | { page: 'search'; query: string } | { page: 'show'; id: number } | { page: 'season'; id: number; season: number }
  | { page: 'cast'; id: number; showId?: number };

export interface Screen {
  ready: Promise<void>;
  refresh(): Promise<void>;
  refreshRatings?(): Promise<void>;
  dispose(keepLayout?:boolean): void;
}

export type SettingsFocus = 'tmdb-key-label' | 'dropbox-label';

export interface ScreenContext {
  openTraktImport?: () => void;
  openAniListImport?: () => void;
  signInDropbox?: () => void;
  canSignInDropbox?: () => boolean;
  canAccessKeys?: () => boolean;
  service: TmdbService;
  critics?: MdbListService;
  imdb?: ImdbService;
  mal?: MalService;
  go(route: Route, focusTarget?:SettingsFocus): void;
  searchQuery(query: string): void;
  selectList(name: string): void;
  saveView(state: LibraryPreferences | { moreSort: 'left' | 'title' }): void;
  run(action: () => Promise<void>, signal?: AbortSignal): Promise<void>;
  clearUndo(): void;
  watch: Pick<WatchActions, 'recordGeneration' | 'episode' | 'bulk' | 'setSeasonCount' | 'remove' | 'setRating' | 'setMembership' | 'setDropped' | 'createList' | 'renameList' | 'deleteList'>;
}
