# csvTV reference

[Back to setup and Cloudflare hosting](../README.md)

## Dropbox sign-in for a shared site

Register one Dropbox app for your site's production address using the [Dropbox setup steps](../README.md#2-register-a-dropbox-app). When building csvTV from source, set the `CSVTV_DROPBOX_APP_KEY` environment variable to the public **App key** and run `npm run release` from `app/`. Upload the resulting ZIP to that Pages project. New visitors can select **Sign in to Dropbox** and use their own accounts. Each person's record stays in their own Dropbox app folder.

## Use csvTV offline

While online, open **Settings → Offline access**. If you see **Open the page to bookmark**, follow that link first. Once Settings says **Ready to open offline**, open **Library** and bookmark it on that device. Use that bookmark when offline. Your edits sync when you reconnect with the same Dropbox account.

## Sync and recovery

On a second device, open the same csvTV site, enter your existing Dropbox app key if prompted, and sign in with the same Dropbox account.

If an older Dropbox clear conflicts with offline edits and csvTV cannot tell which happened last, it lists the affected categories. **Keep local edits** uses this device’s copy of those categories for the next sync. **Use Dropbox** takes the Dropbox copies. **Decide later** preserves both until you choose.

If Dropbox loses a save reply and two viewing counts are still possible, csvTV shows both totals. Choose once for a whole season or expand it to decide individual episodes. You can cancel and return to the decision with **Sync now**.

Each linked device remembers the public Dropbox app key for its record. Keep using that key when you move or update the site. An older installation may ask for its original key so it can confirm the folder before syncing. If you have lost access to that folder, export your record before clearing the device and linking a new folder.

On upgrade, csvTV renames old **Favourites** and **Stopped** memberships to **Favorites** and **Dropped**. The next successful sync updates the working CSVs. You can still open an older backup.

## Watchlist and custom lists

Watchlist holds shows you plan to start. After the first recorded episode, a series appears in More to watch while regular aired episodes remain. A caught-up series returns there when a new episode airs.

In Lists, choose **New list**, enter its name and create it. Search for a show and choose **Add**. The list can stay empty.

Use **Sort** beside the search field to order shows by title, personal rating or play count. All custom lists share this choice, and Dropbox remembers it independently of Ratings.

## Privacy on your instance

- Use a dedicated HTTPS origin and keep the supplied hosting headers. Code deployed to that origin can access the local watch record and act with the browser’s current Dropbox grant.
- Anyone who can read your Dropbox app folder’s working `settings.csv` can read the provider keys it contains. Use a separate private repository and a fine-grained, read-only Contents token for the optional ratings jobs.
- The Dropbox session can last up to seven days. Signing out keeps your offline history. On a shared computer, use **Settings → Offline access → Clear this device** to remove the local record.
- If device storage fills up during sign-out, free some space and choose **Finish sign-out** in the current version of csvTV. An older version can still use an unrevoked grant. If csvTV says that only this tab has paused Dropbox, keep the tab open until sign-out finishes.
- **Settings → Notification log** keeps the latest 30 banner messages on this device. Clearing the device erases the log.
- Back restores the Library search, filters and opened card, the selected custom list, or the sort on Watchlist. Browsing history holds a random reference to the saved view. Clearing the device erases the saved views and their encryption key. A pending view change can survive an immediate reload in an encrypted tab draft for up to two minutes.
- If you leave while a Library sort is saving, the tab can recover that choice for two minutes. The tab stores the sort name, an expiry and a device-signed proof.
- If an offline installation runs out of space, free up device storage and retry in **Settings → Offline access**. An interrupted repair keeps the app files it has already verified.
- Watch-record exports contain your history, ratings and lists. When opening CSVs in a spreadsheet, import text columns as text so a title or list name is displayed literally.

## Run locally

Install Node.js 24 or later and Chrome, Chromium or Edge. From the repository root, run the following commands.

```sh
cd app
npm ci
npm test
npm start
```

Open [csvTV on this computer](http://127.0.0.1:4173/). The tests use fictional records, temporary browser profiles and simulated providers. Set `CSVTV_BROWSER` to your Chromium executable if the tests cannot find it. In PowerShell you can use `npm.cmd`.

## Code and tests

| Directory | Contents |
| --- | --- |
| `app/src/` | TypeScript application, CSV record model, provider clients, importers, storage and sync |
| `app/test/` | Acceptance tests, fictional fixtures, isolated browser checks and benchmarks |
| `jobs/imdb/` and `jobs/mal/` | Optional GitHub Actions templates for maintaining ratings files in a separate private repository |

From `app/`, run `npm run check` to type-check, `npm test` for the standard suite and `npm run release` to build `app/release/csvTV.zip`. For an offline browser rehearsal of Dropbox sign-in, key saving, offline edits and sync, build the release and run `npm run test:dropbox-release-live -- --rehearse`.

Run `npm run test:dropbox-release-live -- --controls --rehearse` to exercise Sync now, Back up now, Merge, Restore, Clear Dropbox and Sign out in the packaged app. Omit `--rehearse` to run the same checks in a new fictional Dropbox folder using a development app and one sign-in.

Two optional Playwright checks use fictional Dropbox files. From `app/` after a build, run `node test/dropbox-lifecycle-audit.mjs 270 15` for a 270-minute offline, restart and sync test. Run `node test/dropbox-merge-performance.mjs chromium 43200` to compare first-sync times for 43,200 episode rows in Chrome, or replace `chromium` with `webkit` to use Playwright’s WebKit. Both checks need `playwright-core` and the selected browser. Set `CSVTV_PLAYWRIGHT_MODULE` to the module’s path if it is installed separately.

If two IMDb titles share an episode number and their scores disagree, csvTV leaves that episode score blank. The app can apply this rule to an existing ratings file, including a copy already saved offline.

The in-app help for each GitHub ratings job supplies the workflow, builder and setup instructions. To exercise both jobs locally, install Git and Bash and run this from the repository root.

```sh
node --test jobs/imdb/build.test.mjs app/test/mal-builder.test.mjs jobs/publication.test.mjs
```

## License

You can use, modify and redistribute csvTV’s own code under the MIT license. Keep the copyright and permission notice with your copies. The Cloudflare ZIP includes it as `LICENSE.txt`. [MIT license](../LICENSE)

The bundled zip.js library carries its BSD-3-Clause notice in `zip-native.js`. Provider data and logos remain subject to their providers’ terms. csvTV displays the TMDB attribution in Settings. [TMDB attribution guidelines](https://developer.themoviedb.org/docs/faq)
