import assert from 'node:assert/strict';

/** A source can expose its option before IndexedDB finishes supplying its scores. */
export async function exerciseProviderSort(browser, source, rankedTitles) {
  const select = 'document.querySelector(".sort-trigger")';
  const titles = 'Array.from(document.querySelectorAll(".library-grid strong"), row => row.textContent)';
  await browser.waitFor(select + '?.querySelector("option[value=' + source + ']")');
  const alphabetical = [...rankedTitles].sort();
  for (const [value, order] of [[source, rankedTitles], ['title', alphabetical], [source, rankedTitles]]) {
    await browser.evaluate('(() => {const control = ' + select + '; control.focus(); control.value = ' +
      JSON.stringify(value) + '; control.dispatchEvent(new Event("change",{bubbles:true}));})()');
    assert.equal(await browser.evaluate(select + '.value'), value);
    await browser.waitFor(select + '.value === ' + JSON.stringify(value) + ' && JSON.stringify(' + titles + ') === ' +
      JSON.stringify(JSON.stringify(order)), 'Library sorted by ' + value);
    assert.ok(await browser.evaluate('document.activeElement === ' + select));
  }
}
