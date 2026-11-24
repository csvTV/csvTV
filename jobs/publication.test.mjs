// Run the workflow shell steps against a disposable Git remote and a stub visibility API.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bash = process.env.BASH_PATH || (process.platform === 'win32'
  ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash');

function stepScript(yaml, name) {
  const lines = yaml.split(/\r?\n/);
  const step = lines.findIndex(line => line.trim() === '- name: ' + name);
  assert.ok(step >= 0, 'Missing workflow step ' + name);
  let start = step + 1;
  while (lines[start]?.startsWith('        ') && lines[start].trim() !== 'run: |') start++;
  assert.equal(lines[start]?.trim(), 'run: |');
  let end = start + 1;
  while (lines[end]?.startsWith('          ')) end++;
  return lines.slice(start + 1, end).map(line => line.slice(10)).join('\n');
}

test('IMDb downloads use HTTPS and enforce a byte ceiling for both datasets', async t => {
  const dir = await mkdtemp(join(tmpdir(),'csvtv-imdb-download-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const yaml = await readFile(new URL('./imdb/imdb-ratings.yml', import.meta.url), 'utf8');
  const mock = 'curl() { printf "%s\\0" "$@" __end__; }';
  const result = spawnSync(bash, ['-e','-s'], {cwd:dir, env:{...process.env,RUNNER_TEMP:'.'},
    encoding:'utf8', input:mock + '\n' + stepScript(yaml,"Download IMDb's files")});
  assert.equal(result.status, 0, result.stderr);
  const calls = result.stdout.split('__end__\0').filter(Boolean).map(call=>call.split('\0').filter(Boolean));
  assert.equal(calls.length, 2);
  for (const [i, [name, limit]] of [['title.episode.tsv.gz','192M'],['title.ratings.tsv.gz','32M']].entries()) {
    const args = calls[i];
    assert.equal(args[0], '--disable');
    for (const [option, value] of [['--proto','=https'],['--proto-redir','=https'],['--max-redirs','3'],
      ['--max-filesize',limit],['--output',name]]) {
      assert.ok(args.includes(option), option);
      assert.equal(args[args.indexOf(option)+1], value, option);
    }
    assert.ok(args.includes('--fail') && args.includes('--remove-on-error'));
    assert.ok(!args.includes('--insecure'));
    assert.equal(args.at(-1), 'https://datasets.imdbws.com/' + name);
  }
});

test('oversized local MyAnimeList inputs preserve the prior ratings file', async t => {
  const dir = await mkdtemp(join(tmpdir(),'csvtv-mal-cache-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const output = join(dir,'mal-ratings.csv.gz');
  await writeFile(output, 'previous fictional snapshot');
  const mapping = join(dir,'anime-list-mini.json'), ranking = join(dir,'ranking.json');
  const builder = fileURLToPath(new URL('./mal/mal-build.mjs',import.meta.url));
  for (const [path, size, name] of [[mapping,16 * 1024 * 1024,'anime-list-mini.json'],[ranking,32 * 1024 * 1024,'ranking.json']]) {
    await Promise.all([writeFile(mapping, '[]'), writeFile(ranking, '[]')]);
    await truncate(path, size + 1);
    const run = spawnSync(process.execPath,[builder,output,dir],{encoding:'utf8'});
    assert.notEqual(run.status, 0);
    assert.ok(run.stderr.includes('could not read cached ' + name + ' within its size limit'));
    assert.equal(await readFile(output,'utf8'), 'previous fictional snapshot');
  }
});

for (const [job, workflow, branch, filename] of [
  ['imdb', 'imdb-ratings', 'data', 'imdb-ratings.csv.gz'],
  ['mal', 'mal-ratings', 'mal-data', 'mal-ratings.csv.gz'],
]) {
  test(job + ' publishes only private, newer snapshots to the expected branch tip', async t => {
    const root = await mkdtemp(join(tmpdir(), 'csvtv-publication-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bare = join(root, 'test', 'ratings.git');
    const ref = 'refs/heads/' + branch;
    const yaml = await readFile(new URL('./' + job + '/' + workflow + '.yml', import.meta.url), 'utf8');
    assert.ok(yaml.includes('group: csvtv-publish-' + branch));
    assert.ok(yaml.includes('cancel-in-progress: false'));
    assert.match(yaml,/uses: actions\/setup-node@[0-9a-f]{40}[^\n]*\n        with:\s+node-version: 22\s+package-manager-cache: false/);
    const guard = stepScript(yaml, 'Verify the repository is private');
    const publish = stepScript(yaml, 'Publish a newer snapshot to ' + branch);
    function git(...args) {
      const run = spawnSync('git', args, { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout.trim();
    }
    git('init', '-q', '--bare', bare);
    const tip = () => git('--git-dir', bare, 'for-each-ref', '--format=%(objectname)', ref);
    const mock = [
      'gh() {',
      '  [[ "$*" == "api repos/test/ratings --jq .visibility" ]] || return 2',
      '  if [[ -n "$RACE_HEAD" ]]; then git --git-dir="$RACE_REMOTE" update-ref "$RACE_REF" "$RACE_HEAD"; fi',
      '  [[ "$VISIBILITY" != unavailable ]] || return 1',
      '  echo "$VISIBILITY"',
      '}',
    ].join('\n');
    async function step(script, visibility, number, raceHead = '') {
      const cwd = await mkdtemp(join(root, 'runner-'));
      await writeFile(join(cwd, filename), 'snapshot ' + number);
      const result = spawnSync(bash, ['-e', '-s'], {
        cwd, input: mock + '\n' + script + '\n', encoding: 'utf8',
        env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_RUN_NUMBER: String(number),
          GITHUB_REPOSITORY: 'test/ratings', GITHUB_SERVER_URL: pathToFileURL(root).href,
          VISIBILITY: visibility, RACE_HEAD: raceHead, RACE_REMOTE: bare, RACE_REF: ref },
      });
      if (result.error) throw result.error;
      return result;
    }

    assert.equal((await step(guard, 'private', 1)).status, 0);
    for (const blocked of ['public', 'internal', '', 'unavailable']) {
      assert.notEqual((await step(guard, blocked, 1)).status, 0);
      assert.notEqual((await step(publish, blocked, 1)).status, 0);
      assert.equal(tip(), '');
    }
    const first = await step(publish, 'private', 2);
    assert.equal(first.status, 0, first.stderr);
    const firstTip = tip();
    assert.ok(firstTip);
    assert.equal((await step(publish, 'private', 1)).status, 0);
    assert.equal((await step(publish, 'private', 2)).status, 0);
    assert.equal(tip(), firstTip);
    const next = await step(publish, 'private', 3);
    assert.equal(next.status, 0, next.stderr);
    assert.notEqual(tip(), firstTip);
    assert.equal(git('--git-dir', bare, 'show', ref + ':' + filename), 'snapshot 3');
    assert.equal(git('--git-dir', bare, 'rev-list', '--count', ref), '1');
    // An independent writer changes the tip during the final visibility check.
    const race = await step(publish, 'private', 4, firstTip);
    assert.notEqual(race.status, 0);
    assert.equal(tip(), firstTip);

    // Existing installations use an unmarked, single-file snapshot.
    const legacy = await mkdtemp(join(root, 'legacy-'));
    git('-C', legacy, 'init', '-q', '-b', branch);
    await writeFile(join(legacy, filename), 'legacy snapshot');
    git('-C', legacy, 'add', filename);
    const commit = ['-C', legacy, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm'];
    git(...commit, 'Unrelated branch');
    git('-C', legacy, 'push', '-qf', bare, branch);
    const unrelated = tip();
    assert.notEqual((await step(publish, 'private', 5)).status, 0);
    assert.equal(tip(), unrelated);
    const label = job === 'imdb' ? 'IMDb ratings' : 'MyAnimeList scores';
    await writeFile(join(legacy, 'keep.txt'), 'independent work');
    git('-C', legacy, 'add', 'keep.txt');
    git(...commit, label + ' 2026-11-01', '-m', 'csvTV-Run: 3', '--amend');
    git('-C', legacy, 'push', '-qf', bare, branch);
    const mixed = tip();
    assert.notEqual((await step(publish, 'private', 5)).status, 0);
    assert.equal(tip(), mixed);
    assert.equal(git('--git-dir', bare, 'show', ref + ':keep.txt'), 'independent work');
    git('-C', legacy, 'rm', '-q', 'keep.txt');
    git(...commit, label + ' 2026-11-01', '--amend');
    const originalRoot = git('-C', legacy, 'rev-parse', 'HEAD');
    git(...commit, label + ' 2026-11-01', '--allow-empty');
    git('-C', legacy, 'push', '-qf', bare, branch);
    const withHistory = tip();
    assert.notEqual((await step(publish, 'private', 5)).status, 0,
      'A matching file and subject cannot authorize replacing an existing branch history');
    assert.equal(tip(), withHistory);
    // Check unusual file modes separately on an original root commit.
    git('-C', legacy, 'switch', '--detach', originalRoot);
    git('-C', legacy, 'update-index', '--chmod=+x', filename);
    git(...commit, label + ' 2026-11-01', '--amend');
    git('-C', legacy, 'push', '-qf', bare, 'HEAD:' + ref);
    const differentMode = tip();
    assert.notEqual((await step(publish, 'private', 5)).status, 0);
    assert.equal(tip(), differentMode);
    git('-C', legacy, 'update-index', '--chmod=-x', filename);
    git(...commit, label + ' 2026-11-01', '-m', 'csvTV-Run: 18446744073709551616', '--amend');
    git('-C', legacy, 'push', '-qf', bare, 'HEAD:' + ref);
    const laterGeneration = tip();
    assert.equal((await step(publish, 'private', 5)).status, 0);
    assert.equal(tip(), laterGeneration, 'A newer generation remains newer beyond shell integer precision');
    git(...commit, label + ' 2026-11-01', '--amend');
    git('-C', legacy, 'push', '-qf', bare, 'HEAD:' + ref);
    const migrated = await step(publish, 'private', 5);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.equal(git('--git-dir', bare, 'show', ref + ':' + filename), 'snapshot 5');
  });
}
