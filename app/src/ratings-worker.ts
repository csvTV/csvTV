import { readImdbEpisodes, readImdbShows } from './imdb-file.ts';
import { RatingsFileLimitError } from './ratings-csv.ts';
import type { ReadWorkerReply } from './read-worker.ts';

type Index = Awaited<ReturnType<typeof readImdbShows | typeof readImdbEpisodes>>;
const scope = globalThis as unknown as {
  onmessage: (event:MessageEvent<{file:Blob; show?:number}>) => void;
  postMessage: (reply:ReadWorkerReply<Index>) => void;
};

scope.onmessage = async ({data:{file,show}}) => {
  if (typeof DecompressionStream !== 'function') {
    scope.postMessage({failure:'unavailable'});
    return;
  }
  try {
    const progress = (rows:number) => scope.postMessage({rows});
    progress(0);
    const index = show === undefined ? await readImdbShows(file,{progress}) : await readImdbEpisodes(file,show,{progress});
    scope.postMessage({result:index});
  } catch (error) {
    scope.postMessage({failure:error instanceof RatingsFileLimitError ? 'limit' : 'invalid'});
  }
};
