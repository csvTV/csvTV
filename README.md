# csvTV

Track TV and anime episodes, rewatches, ratings and lists. Your watch record syncs between devices through Dropbox.

## 1. Create your Cloudflare Pages site

1. **[Download csvTV.zip](https://github.com/csvTV/csvTV/releases/latest/download/csvTV.zip)** and leave it zipped.
2. Sign in to Cloudflare. In **Workers & Pages**, select **Create application**. Under **Pages**, choose **Get started → Drag and drop your files**. [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
3. Name your project, upload `csvTV.zip`, and select **Deploy site**. Open the production address Cloudflare gives you. This is your csvTV site.

## 2. Register a Dropbox app

1. On your csvTV site’s **Connect Dropbox** screen, select the help button beside **Dropbox**. Copy **Redirect URI for this site** and keep the tab open.
2. In a second tab, create a Dropbox app. Choose **Scoped access** and **App folder**, give it a unique name, and select **Create app**. [Dropbox App Console](https://www.dropbox.com/developers/apps/create)
3. Under **Permissions**, enable `files.metadata.read`, `files.content.read` and `files.content.write`. Select **Save changes**.
4. Under **Settings**, enable **Allow public clients**. Paste the address from csvTV into **Redirect URIs** and select **Add**. Then copy the **App key** from the same page.

## 3. Sign in to csvTV with Dropbox

1. Return to your csvTV tab and select **Done** to close the help panel.
2. Select **Add app key**, paste the Dropbox **App key**, and select **Save app key**.
3. Select **Sign in to Dropbox** and approve access. Dropbox returns you to csvTV.

## 4. Add your TMDB key

1. Sign in to TMDB and copy your **API Read Access Token**. If this is your first time using its API, register for access on that page first. [TMDB API settings](https://www.themoviedb.org/settings/api)
2. In csvTV, open **Settings** and select **Add key** beside **TMDB key**. Paste the token and select **Save**. You can now search for shows and mark episodes watched.

## 5. Optional ratings and imports

- **Add ratings.** In **Settings**, add an **MDBList key** for Rotten Tomatoes, Metacritic and MyAnimeList show scores. Open **IMDb ratings** to use OMDb, or choose a GitHub job under **IMDb ratings** or **MyAnimeList scores**.
- **Import your watch history.** Both imports work with just Dropbox and TMDB. While online, open **Settings** and choose **Import from Trakt** for a Trakt ZIP or **Import from AniList** for an AniList JSON file. Review the matches before importing.

## Update your site

Upload the latest `csvTV.zip` to the same Pages project under **Create a new deployment → Production**. You keep the same address and Dropbox connection. [Cloudflare Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/)

## Privacy and development

Provider keys are stored as plain text in `settings.csv` in your Dropbox app folder. Keep that file private. [Offline use, account recovery and developer setup](app/REFERENCE.md) · [Hosting for other people](app/REFERENCE.md#dropbox-sign-in-for-a-shared-site)

csvTV is [MIT licensed](LICENSE). The bundled zip.js library uses the BSD-3-Clause license. Provider data and logos retain their respective terms.
