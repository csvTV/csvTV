import assert from 'node:assert/strict';
import test from 'node:test';
import {readCsv,writeCsv} from '../src/csv.ts';
import {broadcastSeasons,broadcastPosition} from '../src/broadcast-seasons.ts';
import {manualSeasonRanges,decodeSeasonBreaks,encodeSeasonBreaks,seasonOrderKey} from '../src/season-order.ts';

test('Custom season boundaries work on arbitrary shows and preserve native episode positions as the series grows',() => {
  const show = {show_id:9376632,seasons:[{season:0,episodeCount:1},{season:1,episodeCount:32},{season:2,episodeCount:15}],
    manualSeasonOrder:'1/32:12,24;2/15:7'};
  const rows = [{setting:seasonOrderKey(show.show_id),value:show.manualSeasonOrder}];
  assert.deepEqual(readCsv('settings',writeCsv('settings',rows)).rows,rows);
  assert.equal(encodeSeasonBreaks(decodeSeasonBreaks(show.manualSeasonOrder)),show.manualSeasonOrder);
  const groups = broadcastSeasons(show);
  assert.deepEqual(groups.map(r=>[r.sourceSeason,r.first,r.last]),[[1,1,12],[1,13,24],[1,25,32],[2,1,7],[2,8,15]]);
  assert.deepEqual(broadcastPosition(groups,2,9),{season:5,episode:2});
  assert.deepEqual(broadcastPosition(groups,0,1),{season:0,episode:1});
  show.seasons[2].episodeCount = 16;
  assert.equal(broadcastSeasons(show).at(-1).last,16);
  show.seasons[1].episodeCount = 12;
  assert.equal(manualSeasonRanges(show),undefined,'discard stale breaks after a native split');
  assert.equal(broadcastSeasons({...show,manualSeasonOrder:'native',broadcastOrder:groups}),null);
});

test('Malformed or ambiguous manual break values remain outside the recognized settings schema',() => {
  for (const value of ['1/32:0','1/32:32','1/32:12,12','1/32:24,12','1/32:1;1/32:2','0/2:1','2/5:2;1/3:1','1/32:1e1','1/32: 4','1/32:9007199254740993']) {
    assert.equal(decodeSeasonBreaks(value),null,value);
    const result = readCsv('settings','setting,value\r\nseason_order.123,"'+value+'"\r\n');
    assert.equal(result.rows.length,0,value);
    assert.ok(result.findings.length>0 || result.schema !== 'known',value);
  }
});
