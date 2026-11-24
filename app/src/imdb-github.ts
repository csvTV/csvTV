import { GithubRatingsClient, type GithubClientOptions } from './github-ratings-client.ts';
import { indexImdbShows } from './ratings-worker-client.ts';
export { GithubRatingsError as ImdbGithubError } from './github-ratings-client.ts';
export { validGithubRepo } from './csv.ts';

export type ImdbDownload = Exclude<Awaited<ReturnType<ImdbGithubClient['download']>>, {unchanged:true}>;
export class ImdbGithubClient extends GithubRatingsClient<Awaited<ReturnType<typeof indexImdbShows>>> {
  constructor(options:GithubClientOptions = {}, signal?:AbortSignal) { super('imdb', file=>indexImdbShows(file,signal), options); }
}
