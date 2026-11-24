import type { TmdbService } from './tmdb-service.ts';
import { visibleListRows } from './upcoming-preference.ts';

type RatingProvider = {
  status(): Promise<{enabled:boolean; retryAt?:number}>;
  wake(): void;
} & ({ refresh(ids: ReadonlySet<number>): Promise<void> } | { refreshFile(): Promise<void> });

/** Each source owns its retry deadline and unfinished work, independent of other metadata jobs. */
export class RatingRefreshJob {
  readonly #service: TmdbService;
  readonly #provider: RatingProvider;
  readonly #targets:()=>ReturnType<TmdbService['store']['metadataTargets']>;
  #active?: Promise<void>;
  #retry?: ReturnType<typeof setTimeout>;
  #retryRead = 0;
  #generation = 0;
  #requested = false;
  #closed = false;
  interrupted = false;

  constructor(service: TmdbService, provider: RatingProvider, targets=()=>service.store.metadataTargets()) {
    this.#service = service;
    this.#provider = provider;
    this.#targets = targets;
  }
  hidden() { if (this.#active) this.interrupted = true; }
  invalidate() {
    ++this.#generation;
    ++this.#retryRead;
    clearTimeout(this.#retry);
    this.#active = undefined;
  }
  close() { this.#closed = true; this.invalidate(); }

  run(): Promise<void> {
    this.#requested = true;
    if (this.#active) return this.#active;
    const generation = this.#generation;
    this.#active = this.#drain(generation).finally(() => {
      if (generation === this.#generation) this.#active = undefined;
    });
    return this.#active;
  }
  async #drain(generation: number) {
    const {store, environment} = this.#service;
    const canContinue = () => !this.#closed && this.#generation === generation &&
      store.role === 'writer' && environment.visible() && environment.online();
    while (this.#requested && !this.#closed && this.#generation === generation && store.role === 'writer') {
      this.#requested = false;
      this.interrupted = !environment.visible();
      if (this.interrupted || !environment.online()) return;
      const status = await this.#provider.status();
      if (!canContinue()) return;
      if (status.enabled && 'refreshFile' in this.#provider) {
        await this.#provider.refreshFile();
      } else if (status.enabled && 'refresh' in this.#provider) {
        const {tables} = await this.#targets();
        if (!canContinue()) return;
        const ids = new Set<number>();
        for (const table of [tables.watched, tables.ratings, visibleListRows(tables.lists)]) {
          for (const row of table) ids.add(row.show_id);
        }
        await this.#provider.refresh(ids);
      }
      if (this.#generation === generation) await this.scheduleRetry();
    }
  }
  async scheduleRetry() {
    if (this.#closed) return;
    const read = ++this.#retryRead;
    const {retryAt} = await this.#provider.status();
    if (this.#retryRead !== read) return;
    clearTimeout(this.#retry);
    if (retryAt !== undefined && this.#service.store.role === 'writer') {
      const delay = Math.max(1, Math.min(2_147_483_647, retryAt - this.#service.environment.now()));
      this.#retry = setTimeout(() => this.#provider.wake(), delay);
    }
  }
}
