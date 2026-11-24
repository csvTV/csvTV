import test from "node:test";
import assert from "node:assert/strict";
import { csvColumns, readCsv, validateRow, writeCsv } from "../src/csv.ts";

const watchedHeader = csvColumns.watched.join(",");
const watched = (changes = {}) => ({
  show_id: 12, show: "Fictional, Show", season: 0, episode: 1, title: 'A "quiet"\r\nopening',
  times_watched: 1, episode_id: null, ...changes,
});
const csv = (table, ...rows) => [csvColumns[table].join(","), ...rows].join("\n");

test('reordered watch rows retain independent fields across empty cells and rejected integers', () => {
  const text = ['episode_id,episode,title,show_id,season,times_watched,show',
    '101,1,Opening,0000004,01,2,First show',
    '2,2,Rejected,4,1,9007199254740992,Invalid count',
    ',00000000000000000000000003,,4,1,1,',
    '0009007199254740991,4,Last,4,1,999999999999999,First show'].join('\n');
  const parsed = readCsv('watched',text);
  assert.deepEqual(parsed.findings.map(f => [f.line,f.field]), [[3,'times_watched']]);
  assert.deepEqual(parsed.rows.map(r => [r.episode,r.title,r.show,r.episode_id,r.times_watched]), [
    [1,'Opening','First show',101,2], [3,'','',null,1], [4,'Last','First show',Number.MAX_SAFE_INTEGER,999999999999999],
  ]);
  assert.deepEqual(readCsv('watched',writeCsv('watched',parsed.rows)).rows.map(r=>r.episode).sort(),[1,3,4]);
});

test('only historical built-in list names consolidate, keeping each show and custom spelling', () => {
  const rows = [['FavouriteS',7,'Older title'],['favorites',7,'Alternative'],['Favorites',7,'Preferred'],
    ['sToPpEd',8,'Named'],['DROPPED',8,''],['FAVOURITES',9,'Another'],
    ['My Favourites',7,'Custom'],['Stopped watching',8,'Custom'],['Favorites ',7,'Spaced']].map(
      ([list,show_id,show])=>({list,show_id,show}));
  const contents = csv('lists',...rows.map(({list,show_id,show})=>[list,show_id,show].join(',')));
  const read = readCsv('lists',contents);
  assert.deepEqual(read.findings,[]);
  assert.equal(read.normalizedListNames,true);
  assert.deepEqual(read.rows.map(row=>[row.list,row.show_id,row.show]),[
    ['Favorites',7,'Preferred'],['Dropped',8,'Named'],['Favorites',9,'Another'],
    ['My Favourites',7,'Custom'],['Stopped watching',8,'Custom'],['Favorites ',7,'Spaced']]);
  const serialized = writeCsv('lists',rows);
  assert.equal(serialized,writeCsv('lists',[...rows].reverse()));
  assert.equal(serialized,writeCsv('lists',read.rows));
  assert.equal(readCsv('lists',serialized).normalizedListNames,undefined);
  assert.equal(readCsv('lists',contents+'\nFavouriteS,7,Another').findings[0].kind,'duplicate');
  assert.throws(()=>writeCsv('lists',[...rows,rows[0]]),/Duplicate/);
});

test('an empty list declaration round trips independently from real show ID zero', () => {
  const name = '"Evening, shows"';
  const input = csv('lists',name+',,',name+',0,',name+',8,Paper Station');
  const parsed = readCsv('lists',input);
  assert.deepEqual(parsed.findings,[]);
  assert.equal(parsed.rows.length,3);
  assert.equal(parsed.rows.filter(row=>row.show_id === 0).length,1);
  assert.equal(writeCsv('lists',parsed.rows).trimEnd(),input.replaceAll('\n','\r\n'));
  const duplicate = readCsv('lists',input+'\n'+name+',,');
  assert.deepEqual(duplicate.findings.map(f=>f.kind),['duplicate']);
  for (const invalid of ['Evening,,Title with no ID','Evening,-1,','Watchlist,,','Dropped,,','Anime,,']) {
    const result = readCsv('lists',csv('lists',invalid));
    assert.equal(result.rows.length,0,invalid);
    assert.equal(result.findings[0].field,'show_id',invalid);
  }
});

test("all five tables round trip with a canonical header, minimal quoting and final CRLF", () => {
  const tables = {
    watched: [watched()],
    ratings: [{ show_id: 7, show: " Spaced\uFEFF ", rating: 9 }],
    lists: [{ list: "Drama; Comedy", show_id: 7, show: "First\nSecond" }],
    shows: [{ show_id: 7, show: "", year: null, imdb_id: "tt0000012" }],
    settings: [{ setting: "imdb_source", value: "github" }],
  };
  for (const [table, rows] of Object.entries(tables)) {
    const output = writeCsv(table, rows);
    assert.equal(writeCsv(table, []), csvColumns[table].join(",") + "\r\n");
    assert.ok(output.endsWith("\r\n"));
    const read = readCsv(table, new TextEncoder().encode(output));
    assert.deepEqual(read.rows, rows);
    assert.deepEqual(read.findings, []);
    assert.equal(read.schema, "known");
  }
  assert.equal(writeCsv("watched", tables.watched), watchedHeader + '\r\n12,"Fictional, Show",0,1,"A ""quiet""\r\nopening",1,\r\n');
  assert.equal(writeCsv("ratings", tables.ratings), "show_id,show,rating\r\n7, Spaced\uFEFF ,9\r\n");
});

test("reader honors raw column order, BOM, leading zeros, blank physical lines and unterminated final record", () => {
  const input = '\uFEFFrating,show_id\n\n09.500,0012\n0,13';
  const result = readCsv("ratings", input);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.header, ["rating", "show_id"]);
  assert.deepEqual(result.rows, [{ show_id: 12, show: "", rating: 9.5 }, { show_id: 13, show: "", rating: 0 }]);
  assert.equal(writeCsv("ratings", result.rows), "show_id,show,rating\r\n12,,9.5\r\n13,,0\r\n");
  const limited = readCsv("watched", "times_watched,episode,season,show_id\n1,2,0,17");
  assert.deepEqual(limited.rows, [watched({ show_id: 17, show: "", title: "", episode: 2 })]);
});

test("three-character combinations round trip across all CSV punctuation and line endings", () => {
  const alphabet = ["", " ", "A", ",", '"', "\r", "\n", "\uFEFF", "\u{10000}"];
  const rows = [];
  for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) {
    rows.push({ show_id: rows.length + 1, show: a + b + c, rating: 0 });
  }
  const canonical = writeCsv("ratings", rows);
  const read = readCsv("ratings", new TextEncoder().encode(canonical));
  assert.deepEqual(read.findings, []);
  assert.deepEqual(read.rows.sort((a, b) => a.show_id - b.show_id), rows);
  assert.equal(writeCsv("ratings", read.rows.toReversed()), canonical);
});

test("header checks distinguish unknown columns, missing columns and duplicate raw names", () => {
  const unknown = readCsv("ratings", "future,show_id,rating\nnew,1,9");
  assert.equal(unknown.schema, "unknown");
  assert.equal(unknown.stopped, false);
  assert.deepEqual(unknown.findings.map(f => [f.kind, f.field]), [["unknown", "future"]]);
  assert.deepEqual(unknown.rows, [{ show_id: 1, show: "", rating: 9 }]);
  const duplicate = readCsv("ratings", 'rating,"rating",show_id\n8,9,1');
  assert.equal(duplicate.stopped, true);
  assert.equal(duplicate.schema, "unconfirmed");
  assert.deepEqual(duplicate.rows, []);
  assert.equal(duplicate.findings[0].field, "rating");
  const missing = readCsv("ratings", "show_id,show");
  assert.deepEqual(missing.findings.map(f => f.field), ["rating"]);
  assert.equal(missing.stopped, true);
  assert.equal(readCsv("ratings", "future,show_id").schema, "unknown");
  for (const input of ["", "\n\r\n", '"never closed']) {
    assert.equal(readCsv("ratings", input).schema, "unconfirmed");
    assert.equal(readCsv("ratings", input).stopped, true);
  }
});

test("physical line locations survive multiline fields and bounded row errors", () => {
  const result = readCsv("ratings", csv("ratings", '1,"multiline\n\ntitle",8', "2,short", "3,Fourth,4,extra", '""', "4,Last,2"));
  assert.deepEqual(result.rows.map(row => row.show_id), [1,4]);
  assert.deepEqual(result.findings.map(f => [f.kind, f.line]), [["row",5], ["row",6], ["row",7]]);
  assert.equal(result.schema, "known");
});

test("broken quotes stop the entire file even when preceding rows were usable", () => {
  const rows = ['1,"Two\nlines",6', "2,Next,8", "3,Last,7"];
  assert.equal(readCsv("ratings", csv("ratings", ...rows)).rows.length, 3);
  for (const input of [
    csv("ratings", '1,"Two\nlines,6', ...rows.slice(1)),
    csv("ratings", ...rows, '4,bad"quote,5'),
    csv("ratings", ...rows, '4,"title"x,5'),
    csv("ratings", ...rows, "4,lone\rending,5"),
  ]) {
    const result = readCsv("ratings", input);
    assert.equal(result.stopped, true);
    assert.deepEqual(result.rows, []);
    assert.equal(result.schema, "known");
  }
  const future = readCsv("ratings", 'show_id,rating,new\n1,3,"unclosed');
  assert.equal(future.schema, "unknown");
  assert.equal(future.stopped, true);
});

test("fatal UTF-8 names the first bad physical line and retains any identified newer schema", () => {
  const bytes = prefix => Uint8Array.from([...new TextEncoder().encode(prefix), 0xe2, 0x28, 0xa1]);
  const result = readCsv("ratings", bytes('show_id,show,rating\r\n1,"Two\nlines",3\r\n'));
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.findings, [{ kind: "fatal", line: 4, reason: "Invalid UTF-8" }]);
  assert.equal(result.schema, "known");
  assert.equal(readCsv("ratings", bytes("new,rating,show_id\n")).schema, "unknown");
  assert.equal(readCsv("ratings", bytes("show_id,")).schema, "unconfirmed");
  assert.equal(readCsv("settings", bytes("setting,value\n")).schema, "unconfirmed");
  assert.equal(readCsv("ratings", "show_id,show,rating\n1,\uD800,3").stopped, true);
});

test("decoder counts bare CR, CRLF, and LF inside a quoted field before invalid Unicode", () => {
  const prefix = 'show_id,show,rating,future\r\n1,"a\rb\r\nc\nd\r';
  const invalidBytes = Uint8Array.from([...new TextEncoder().encode(prefix), 0xff]);
  for (const input of [invalidBytes, prefix + "\uD800"]) {
    const result = readCsv("ratings", input);
    assert.equal(result.stopped, true);
    assert.equal(result.schema, "unknown");
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.findings.map(f => [f.kind, f.line]), [["unknown", 1], ["fatal", 6]]);
  }
});

test("a later invalid byte preserves an earlier quote error without inventing an unterminated field at the decode boundary", () => {
  const bytes = prefix => Uint8Array.from([...new TextEncoder().encode(prefix), 255]);
  const broken = readCsv("ratings", bytes('show_id,show,rating\r\n1,Two"titles,4\r\n'));
  assert.deepEqual(broken.findings.map(f => [f.line, f.reason]), [[2, "Quote inside an unquoted field"], [3, "Invalid UTF-8"]]);
  assert.deepEqual(broken.rows, []);
  const partial = readCsv("ratings", bytes('show_id,show,rating\r\n1,"Two\n'));
  assert.deepEqual(partial.findings.map(f => [f.line, f.reason]), [[3, "Invalid UTF-8"]]);
});

test("integer and half-point fields are checked before rounding or constructing keys", () => {
  for (const invalid of ["", "0", "-1", "+1", " 2", "2.0", "1e2", "١", "9007199254740992"]) {
    assert.equal(readCsv("watched", csv("watched", "1,S,0,1,E," + invalid + ",")).findings[0].field, "times_watched");
  }
  for (const column of ["show_id","season","episode","episode_id"]) {
    const fields = {show_id:"1",show:"S",season:"0",episode:"1",title:"E",times_watched:"1",episode_id:""};
    fields[column] = "9007199254740993";
    const result = readCsv("watched", csv("watched", csvColumns.watched.map(name => fields[name]).join(",")));
    assert.equal(result.rows.length, 0);
    assert.equal(result.findings[0].field, column);
  }
  assert.equal(readCsv("shows", csv("shows", "1,S,9007199254740992,")).findings[0].field, "year");
  assert.equal(readCsv("shows", csv("shows", "1,S,2025,garbled")).findings[0].field, "imdb_id");
  for (const invalid of [".5", "9.50000000000000001", "10.5", "-1", "+3", "3.", "9.25","11"," 2",""]) {
    assert.equal(readCsv("ratings", csv("ratings", "1,S," + invalid)).rows.length, 0);
  }
  const valid = readCsv("watched", csv("watched", "0009007199254740991,S,00,01,E,01,"));
  assert.equal(valid.rows[0].show_id, Number.MAX_SAFE_INTEGER);
  assert.equal(writeCsv("watched", valid.rows), watchedHeader + "\r\n9007199254740991,S,0,1,E,1,\r\n");
  assert.equal(readCsv("ratings", csv("ratings","1,S,010.000")).rows[0].rating, 10);
});

test("watched duplicates sum exactly, keep later text and reject conflicting identities or overflow", () => {
  for (const id of ["", "11"]) {
    const read = readCsv("watched", csv("watched", "1,A,0,1,old,2," + id, "1,B,0,1,new,3," + id));
    assert.deepEqual(read.findings.map(f=>f.kind), ["duplicate"]);
    assert.deepEqual(read.rows, [watched({show_id:1,show:"B",title:"new",times_watched:5,episode_id:id ? 11 : null})]);
  }
  for (const [first,second] of [["",11],[11,""],[10,11]]) {
    const read = readCsv("watched", csv("watched","1,S,1,1,A,1," + first,"1,S,1,1,B,2," + second));
    assert.equal(read.stopped, true);
    assert.deepEqual(read.rows, []);
    assert.equal(read.findings[0].line, 3);
  }
  const overflow = readCsv("watched", csv("watched","1,S,1,1,A,9007199254740991,4","1,S,1,1,A,1,4"));
  assert.equal(overflow.stopped, true);
  assert.match(overflow.findings[0].reason, /\[1,1,1\]/);
});

test("ratings, settings and exact list membership keep the last valid duplicate", () => {
  const ratings = readCsv("ratings", csv("ratings","1,A,10","1,B,0"));
  assert.deepEqual(ratings.rows, [{show_id:1,show:"B",rating:0}]);
  assert.equal(ratings.findings[0].kind, "duplicate");
  const lists = readCsv("lists",csv("lists","Anime,1,A","anime,1,b","Anime,1,B","   ,1,C"));
  assert.deepEqual(lists.rows.map(r=>[r.list,r.show]), [["Anime","B"],["anime","b"]]);
  assert.deepEqual(lists.findings.map(f=>f.kind), ["duplicate","row"]);
  const settings = readCsv("settings", csv("settings","tmdb_key,fake-1","tmdb_key,fake-2"));
  assert.deepEqual(settings.rows, [{setting:"tmdb_key",value:"fake-2"}]);
  assert.equal(settings.findings[0].setting, "tmdb_key");
  assert.doesNotMatch(JSON.stringify(settings.findings), /fake/);
});

test("settings reports contain only names and reasons, and distinguish future settings from damaged values", () => {
  for (const setting of ["future_setting","imdb_source","mal_source","appearance","statistics_scope","watchlist_density","library_sort","more_to_watch_sort"]) {
    const value = "FAKE-SECRET";
    const result = readCsv("settings", csv("settings","github_token,FAKE-SECRET",setting + "," + value));
    assert.equal(result.schema, "unknown");
    assert.equal(result.findings[0].setting, setting);
    assert.doesNotMatch(JSON.stringify(result.findings), /FAKE-SECRET/);
  }
  for (const value of [".", "../name", "owner/..","one/two/three","bad name/repo","/name","name/"]) {
    const result = readCsv("settings", csv("settings","github_repo," + value));
    assert.deepEqual(result.rows, []);
    assert.equal(result.schema, "known");
  }
  for (const input of ['tmdb_key,"FAKE-SECRET','tmdb_key,FAKE-SECRET,extra',',FAKE-SECRET']) {
    const result = readCsv("settings", csv("settings",input));
    assert.equal(result.schema, "unconfirmed");
    assert.doesNotMatch(JSON.stringify(result.findings), /FAKE-SECRET/);
  }
  assert.equal(readCsv("settings",csv("settings","tmdb_key,  ")).findings[0].kind, "row");
  assert.equal(readCsv("settings",csv("settings","github_repo,A-1_d.o/.repo")).rows.length, 1);
});

test("a quoted trailing newline is data and invalidates a number, title ID or repository component", () => {
  for (const ending of ["\n", "\r", "\r\n", "\u2028"]) {
    for (const [table, line, field] of [
      ["ratings", '1,S,"9.5' + ending + '"', "rating"],
      ["shows", '1,S,2020,"tt123' + ending + '"', "imdb_id"],
      ["settings", 'github_repo,"owner/repo' + ending + '"', "value"],
    ]) {
      const read = readCsv(table, csv(table, line));
      assert.equal(read.rows.length, 0);
      assert.equal(read.findings[0].field, field);
    }
  }
});

test("a newer settings format takes precedence over an additional structural failure", () => {
  for (const newer of ["imdb_source,future-mode", "future_setting,FAKE-VALUE"]) {
    const result = readCsv("settings", csv("settings", newer, 'tmdb_key,"FAKE-SECRET'));
    assert.equal(result.stopped, true);
    assert.equal(result.schema, "unknown");
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.findings.map(finding => finding.kind), ["unknown", "fatal"]);
    assert.doesNotMatch(JSON.stringify(result.findings), /future-mode|FAKE/);
  }
});

test("file order compares ASCII-folded code points, exact spelling, then numeric keys", () => {
  const names = ["École","Zebra","anime","Anime","E\u0301cole","aB","Ab","éa","Éb","\u{10000}","\uFFFD"];
  const rows = names.map(list => ({list,show_id:1,show:"S"}));
  const output = writeCsv("lists", rows);
  assert.equal(writeCsv("lists", [...rows].reverse()), output);
  assert.deepEqual(readCsv("lists", output).rows.map(row => row.list),
    ["Ab","aB","Anime","anime","E\u0301cole","Zebra","Éb","École","éa","\uFFFD","\u{10000}"]);
  assert.deepEqual(rows.map(row=>row.list), names);
  const positions = [watched({season:10}), watched({season:2,episode:12}), watched({season:2,episode:1})];
  assert.deepEqual(readCsv("watched",writeCsv("watched",positions)).rows.map(row => [row.season,row.episode]), [[2,1],[2,12],[10,1]]);
  for (const table of ["ratings","shows","settings"]) {
    const unsorted = table === "settings" ? [{setting:"tmdb_key", value:"a"},{setting:"github_token",value:"b"}]
      : [10,1].map(show_id => table === "ratings" ? {show_id, show:"Same", rating:9} : {show_id, show:"Same",year:null,imdb_id:""});
    assert.equal(writeCsv(table, unsorted), writeCsv(table,[...unsorted].reverse()));
  }
});

test("writer rejects invalid internal rows and duplicate keys before producing an output", () => {
  for (const changes of [{times_watched:0},{times_watched:-1},{times_watched:1.5},{episode_id:Infinity},{show_id:2**53},{episode:"01"},{title:"\uD800"}]) {
    assert.throws(() => validateRow("watched", watched(changes)));
    assert.throws(() => writeCsv("watched",[watched(changes)]));
  }
  assert.doesNotThrow(() => validateRow("watched", watched()));
  assert.throws(() => writeCsv("watched",[watched(),watched()]), /Duplicate/);
  assert.throws(() => writeCsv("settings",[{setting:"github_repo",value:"fictional-invalid-key"}]), error => !error.message.includes("fictional-invalid-key"));
});
