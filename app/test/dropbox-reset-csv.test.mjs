import assert from 'node:assert/strict';
import test from 'node:test';
import { readCsv, writeCsv } from '../src/csv.ts';
import { records } from '../src/csv-format.ts';
import { dropboxContentHash } from '../src/dropbox-api.ts';
import { resetCsvPayload } from '../src/dropbox-reset-csv.ts';
import { FictionalDropbox } from './dropbox-sync-fixture-cases.mjs';

const csv = new TextEncoder();

test('Reset preserves the canonical bytes for a missing file or genuinely changed rows', async () => {
  const desired = writeCsv('ratings',[]);
  const existing = writeCsv('ratings',[{show_id:8,show:'Signal Station',rating:9}]);
  for (const reviewed of [null,csv.encode(existing),await dropboxContentHash(existing)]) {
    assert.equal(await resetCsvPayload(desired,reviewed),desired);
  }
});

test('Matching reset payloads round-trip with identical records across all primary CSVs, mixed settings and both derived tables', async () => {
  const title = 'Lumière, "north"\r\nsouth';
  const settings = [{setting:'tmdb_key',value:'fictional-only'},{setting:'appearance',value:'dark'}];
  const sources = [
    ...['watched','ratings','lists'].map(table=>[table,writeCsv(table,[])]),
    ['settings',writeCsv('settings',settings)],
    ['shows',writeCsv('shows',[{show_id:1,show:title,year:2010,imdb_id:''}])],
    ['summary','show,year,season,episodes_watched,times_completed,rating,lists\r\n"Lumière, ""north""\r\nsouth",2010,1,5,1,9,Favourites\r\n'],
  ];
  for (const [table,desired] of sources) {
    for (const reviewed of [csv.encode(desired),await dropboxContentHash(desired)]) {
      const payload = await resetCsvPayload(desired,reviewed);
      assert.equal(payload,desired.replace('\r\n','\n'));
      assert.deepEqual([...records(payload)],[...records(desired)]);
      if (table !== 'summary') {
        const parsed = readCsv(table,csv.encode(payload));
        assert.equal(parsed.findings.length,0);
        assert.equal(writeCsv(table,parsed.rows),desired);
      }
      assert.equal(await resetCsvPayload(desired,await dropboxContentHash(payload)),desired);
    }
  }
});

test('Line-feed-only and BOM-prefixed variants produce distinct but readable CSV when matched', async () => {
  const plain = writeCsv('ratings',[]).replace('\r\n','\n');
  for (const input of [plain,'\uFEFF'+plain]) {
    const other = await resetCsvPayload(input,csv.encode(input));
    assert.notEqual(other,input);
    const checked = readCsv('ratings',csv.encode(other));
    assert.equal(checked.schema,'known');
    assert.deepEqual(checked.findings,[]);
    assert.deepEqual(checked.rows,[]);
  }
});

test('Strict updates reject a delayed pre-reset writer when identical bytes would have kept its revision valid', async () => {
  class SameBytesDropbox extends FictionalDropbox {
    async put(path,payload,...rest) {
      const current = this.live.get(path);
      if (current?.metadata.contentHash === await dropboxContentHash(payload)) return current.metadata;
      return super.put(path,payload,...rest);
    }
  }
  const api = new SameBytesDropbox();
  const name = '/ratings.csv', empty = writeCsv('ratings',[]);
  const old = await api.upload(name,empty,{mode:'add'});
  const checked = {mode:'update',revision:old.rev};
  assert.equal((await api.upload(name,empty,checked)).rev,old.rev);
  const payload = await resetCsvPayload(empty,old.contentHash);
  const cleared = await api.upload(name,payload,checked);
  assert.notEqual(cleared.rev,old.rev);
  const stale = writeCsv('ratings',[{show_id:8,show:'Signal Station',rating:9}]);
  await assert.rejects(api.upload(name,stale,checked),{kind:'conflict'});
  assert.deepEqual(api.rows('ratings'),[]);
});
