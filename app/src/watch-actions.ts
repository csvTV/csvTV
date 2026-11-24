import { markEpisode, removeWatches, undoWatchEdit, validateBroadcastScope, type EpisodeWatchAction, type MarkScope, type WatchDelta } from './marks.ts';
import type { BroadcastSeason } from './broadcast-seasons.ts';
import type { WatchedRow } from './model.ts';
import type { PersonalSnapshot, RatingRecordIdentity } from './storage.ts';
import { createPersonalList, editList, isWatchlist, setListMember, setShowDropped, undoPersonal,
  PersonalRecordError, type ListQuestion, type PersonalEdit, type PersonalShow, type PersonalUndo } from './personal-record.ts';
import { TmdbError } from './tmdb-client.ts';
import type { TmdbService } from './tmdb-service.ts';
import { recordedShowTitle } from './shows.ts';
import type { RecentMarkUndo, WatchReceipt } from './watch-record.ts';

export interface RemovalQuestion { title: string; episodes: number; plays: bigint }
export interface UndoBar { label: string }
export class EpisodeChangedError extends Error {
  constructor() { super('The episode at this position changed. Open its actions again.'); }
}
type PendingUndo = PersonalUndo | { kind: 'watch'; id: number; label: string; changes: WatchDelta[]; recent: RecentMarkUndo };

export class WatchActions {
  private readonly service: TmdbService;
  private readonly confirm: (question: RemovalQuestion) => Promise<boolean>;
  private readonly display: (bar: UndoBar | null) => void;
  private readonly notice: (message: string) => void;
  private readonly confirmList: (question: ListQuestion) => Promise<boolean>;
  #screen = 0;
  #record = 0;
  #pending: PendingUndo | null = null;
  #protected = new Set<string>();
  #protectedLists = new Set<string>();
  #protectedRatings = new Set<string>();
  #protectionVersion = 0;
  #applying = false;

  constructor(service: TmdbService, confirm: (question: RemovalQuestion) => Promise<boolean>,
      display: (bar: UndoBar | null) => void, notice: (message: string) => void,
      confirmList: (question: ListQuestion) => Promise<boolean> = async () => false) {
    this.service = service;
    this.confirm = confirm;
    this.display = display;
    this.notice = notice;
    this.confirmList = confirmList;
  }

  leaveScreen(): void {
    this.#screen++;
    this.#set(null);
  }

  get recordGeneration(): number { return this.#record; }

  /** Resolving a record guard also cancels uncommitted choices from before the decision. */
  clear(): void {
    this.#record++;
    this.leaveScreen();
  }

  /** Merge supplies identities whose count, membership, or rating came from the other device. */
  protect(episodeKeys: Iterable<string>, listKeys: Iterable<string> = [], ratingKeys: Iterable<string> = []): void {
    if (!this.#pending) return;
    for (const key of episodeKeys) this.#protected.add(key);
    for (const key of listKeys) this.#protectedLists.add(key);
    for (const key of ratingKeys) this.#protectedRatings.add(key);
    this.#protectionVersion++;
  }

  #set(action: PendingUndo | null): void {
    this.#pending = action;
    this.#protected = new Set();
    this.#protectedLists = new Set();
    this.#protectedRatings = new Set();
    this.display(action ? { label: action.label } : null);
  }

  #saved(screen: number, id: number, label: string, result: WatchReceipt) {
    if (result.changes.length && screen === this.#screen) {
      this.#set({ id, kind: 'watch', label, changes: result.changes, recent: result.recent });
    }
  }

  async episode(row: Omit<WatchedRow, 'times_watched'>, action: EpisodeWatchAction, current: () => boolean = () => true): Promise<void> {
    const screen = this.#screen;
    const adding = typeof action === 'object' ? action.desiredCount > action.expectedCount : action !== 'remove-one';
    const key = adding ? await this.service.keyStatus() : null;
    if (key && key.status !== 'ready' && !key.cachedMarkAccount) throw new TmdbError('refused');
    const result = await this.service.editWatches(row.show_id, async ({ tables }) => {
      if (screen !== this.#screen || !current()) throw new TmdbError('superseded');
      if (adding) {
        const [parent, season] = await Promise.all([this.service.read({ kind: 'show', id: row.show_id }),
          this.service.read({ kind: 'season', id: row.show_id, season: row.season })]);
        if (parent && !parent.value?.seasons.some(s => s.season === row.season)) throw new TmdbError('not-found');
        const episode = season?.value?.episodes.find(e => e.episode === row.episode);
        if (!episode || episode.episode_id !== row.episode_id) throw new TmdbError('not-found');
        return markEpisode(tables.watched, row, action, season?.value?.reusedPositions?.includes(row.episode));
      }
      const saved = tables.watched.find(r => r.season === row.season && r.episode === row.episode);
      if (saved && saved.episode_id !== row.episode_id) throw new EpisodeChangedError();
      return markEpisode(tables.watched, row, action);
    }, key?.cachedMarkAccount ? {generation:key.generation,accountId:key.cachedMarkAccount} : key?.generation,
      () => screen === this.#screen && current());
    const label = typeof action === 'object' ? 'Episode watches set to ' + action.desiredCount.toLocaleString() + '×' :
      action === 'mark' ? 'Episode marked watched' : action === 'again' ? 'One watch added' : 'One watch removed';
    this.#saved(screen, row.show_id, row.title ? label + ' · ' + row.title : label, result);
  }

  async bulk(id: number, scope: MarkScope, action: 'mark' | 'again' | 'rewatch-complete', current?: () => boolean): Promise<void> {
    const screen = this.#screen, record = this.#record;
    const active = () => record === this.#record && (!current || screen === this.#screen && current());
    const receipt = await this.service.markWithReceipt(id, scope, action, active);
    const count = receipt.changes.length;
    const label = count + (count === 1 ? ' episode' : ' episodes') + (action === 'mark' ? ' marked watched' : ' watched again');
    this.#saved(screen, id, label, receipt);
  }

  async setSeasonCount(id: number, scope: { season: number; broadcast?: BroadcastSeason }, expectedCompleted: number,
      desiredCompleted: number, current: () => boolean = () => true): Promise<void> {
    const screen = this.#screen;
    const result = await this.service.markWithReceipt(id, scope, {expectedCompleted,desiredCompleted},
      () => screen === this.#screen && current());
    this.#saved(screen, id, 'Season watches set to ' + desiredCompleted.toLocaleString() + '×', result);
  }

  async remove(id: number, season?: number, range?: BroadcastSeason): Promise<void> {
    const screen = this.#screen;
    // Reconfirm if the set of episodes or counts changed while the question was open.
    let approved = '';
    const result = await this.service.editWatches(id, async ({ tables }) => {
      if (range) validateBroadcastScope((await this.service.read({ kind: 'show', id }))?.value, range);
      const edit = removeWatches(tables.watched, id, range?.sourceSeason ?? season, range);
      if (!edit.changes.length || screen !== this.#screen) return { rows: tables.watched };
      const signature = JSON.stringify(edit.changes.map(({ row }) => [row.season, row.episode, row.episode_id, row.times_watched]));
      if (approved !== signature) {
        const title = season === undefined ? recordedShowTitle(tables) || 'Show ' + id : season === 0 ? 'Specials' : range?.name ?? 'Season ' + season;
        const plays = edit.changes.reduce((sum, item) => sum - item.change, 0n);
        if (!await this.confirm({ title, episodes: edit.changes.length, plays }) || screen !== this.#screen) return { rows: tables.watched };
        if (range) validateBroadcastScope((await this.service.read({ kind: 'show', id }))?.value, range);
        approved = signature;
      }
      return edit;
    }, undefined, () => screen === this.#screen);
    this.#saved(screen, id, 'Watches removed', result);
  }

  async #editPersonal(plan: (snapshot: PersonalSnapshot) => PersonalEdit | undefined, checkWatched?: readonly number[],
      active: () => boolean = () => true): Promise<boolean> {
    const screen = this.#screen;
    const current = () => this.#screen === screen && active();
    let approved: string | undefined;
    const undo = await this.service.editPersonalRecord(async snapshot => {
      if (!current()) return;
      const edit = plan(snapshot);
      if (!edit) return;
      if (edit.confirmation) {
        // A change in identities invalidates the answer even if the displayed count stays the same.
        const signature = JSON.stringify(edit.confirmation);
        if (signature !== approved && !await this.confirmList(edit.confirmation.question)) return;
        approved = signature;
      }
      return { patch: edit.patch, value: edit.undo };
    }, current, checkWatched);
    if (undo === undefined) return false;
    if (current()) this.#set(undo);
    return true;
  }

  async setRating(show: PersonalShow, rating: number | null, expected?: number, displayed?: RatingRecordIdentity): Promise<boolean> {
    const screen = this.#screen, record = this.#record;
    // The inline editor submits an explicit replacement for the score the user saw.
    // A rating sheet still belongs to the screen that opened it.
    const current = expected === undefined ? () => screen === this.#screen : () => record === this.#record;
    let owner = displayed;
    try {
      const submitted = await this.service.store.ratingState(show.show_id);
      if (owner && (owner.account !== submitted.account || owner.erased !== submitted.erased)) return false;
      owner = submitted;
      const undo = await this.service.editRating(show,rating,expected,submitted,current);
      if (!undo) return false;
      if (screen === this.#screen && current()) this.#set(undo);
      return true;
    } catch (error) {
      // The originating screen reports its own errors. After navigation, report a
      // failed submitted edit only to the same record, without an obsolete Retry.
      if (screen !== this.#screen && owner && current() && this.service.store.role === 'writer') {
        const live = await this.service.store.ratingState(show.show_id).catch(() => undefined);
        if (live && live.account === owner.account && live.erased === owner.erased && current() && this.service.store.role === 'writer')
          this.notice(error instanceof PersonalRecordError ? error.message : 'Rating could not be saved. Open Ratings to try again.');
      }
      throw error;
    }
  }

  setMembership(show: PersonalShow, list: string, member: boolean, current?: () => boolean): Promise<boolean> {
    return this.#editPersonal(snapshot => setListMember(snapshot, show, list, member),
      member && isWatchlist(list) ? [show.show_id] : undefined, current);
  }

  setDropped(show: PersonalShow, dropped: boolean, current?: () => boolean): Promise<boolean> {
    return this.#editPersonal(snapshot => setShowDropped(snapshot, show, dropped), undefined, current);
  }

  createList(name: string, shows: readonly PersonalShow[], options: { requireWatched?: boolean; current?: () => boolean } = {}): Promise<boolean> {
    const check = options.requireWatched ? shows.map(show => show.show_id) : undefined;
    return this.#editPersonal(snapshot => {
      if (check?.some(id => !snapshot.watchedIds.has(id))) {
        throw new PersonalRecordError('A selected show has left the Library. Review your selection.');
      }
      return createPersonalList(snapshot, name, shows);
    }, check, options.current);
  }

  renameList(oldName: string, newName: string, current?: () => boolean): Promise<boolean> {
    return this.#editPersonal(snapshot => editList(snapshot, oldName, newName),undefined,current);
  }

  deleteList(name: string): Promise<boolean> {
    return this.#editPersonal(snapshot => editList(snapshot, name));
  }

  async undo(): Promise<void> {
    const previous = this.#pending;
    if (!previous || this.#applying) return;
    this.#applying = true;
    try {
      let skipped = 0;
      if (previous.kind === 'watch') {
        let version = this.#protectionVersion;
        const result = await this.service.editWatches(previous.id, ({ tables }) => {
          version = this.#protectionVersion;
          return this.#pending === previous
            ? undoWatchEdit(tables.watched, previous.changes, this.#protected) : { rows: tables.watched };
        }, undefined, () => this.#pending === previous && this.#protectionVersion === version, previous.recent);
        skipped = result.skipped;
      } else {
        while (this.#pending === previous) {
          const version = this.#protectionVersion;
          const left = await this.service.editPersonalRecord(async snapshot =>
            undoPersonal(snapshot, previous, this.#protectedLists, this.#protectedRatings),
            () => this.#pending === previous && this.#protectionVersion === version);
          if (left !== undefined) { skipped = left; break; }
        }
      }
      if (this.#pending === previous) this.#set(null);
      if (skipped) this.notice('Undo left ' + skipped + (skipped === 1 ? ' row' : ' rows') + ' changed by sync.');
    } finally { this.#applying = false; }
  }
}
