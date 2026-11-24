import assert from 'node:assert/strict';
import test from 'node:test';
import { ImdbService } from '../dist/imdb-service.js';
import { MalService } from '../dist/mal-service.js';
import { StaleSnapshotError } from '../dist/storage.js';

for (const [job,Service] of [['imdb',ImdbService],['mal',MalService]]) {
  test(job + ' checks the originating editor and ratings configuration when a queued key save resumes', async () => {
    for (const change of ['closed form','new repository','unrelated revision','none']) {
      const store = new EventTarget(), entered = Promise.withResolvers(), resume = Promise.withResolvers();
      const state = {generation:1n,configGeneration:1n,revision:2n,config:{github_repo:'fixture/shows'}};
      let open = true, commits = 0, uploads = 0;
      store[job + 'State'] = async () => structuredClone(state);
      store.commit = async (revision, _edits, options) => {
        if (++commits === 1) { entered.resolve(); await resume.promise; }
        if (!options.current() || revision !== state.revision) throw new StaleSnapshotError();
        uploads++;
      };
      const service = new Service({store,environment:{}});
      try {
        const saving = service.configure('github_token','fictional-key',1n,()=>open);
        await entered.promise;
        if (change === 'closed form') open = false;
        if (change === 'new repository') {
          state.config.github_repo = 'fixture/replacement';
          state.generation++; state.configGeneration++;
          store.dispatchEvent(new Event(job + 'configchange'));
        }
        if (change === 'unrelated revision') state.revision++;
        resume.resolve();
        if (change === 'closed form' || change === 'new repository') {
          await assert.rejects(saving,StaleSnapshotError);
          assert.equal(uploads,0,change);
        } else {
          await saving;
          assert.equal(uploads,1,change);
        }
        assert.equal(commits, change === 'unrelated revision' ? 2 : 1,change);
      } finally { service.close(); }
    }
  });
}
