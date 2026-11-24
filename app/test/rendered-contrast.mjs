import assert from 'node:assert/strict';

// Lay out production components over known artwork. Screen coordinates let the test
// read the pixels the browser actually paints, including native slider pseudo-elements.
function placeSamples(theme, art) {
  document.querySelector('#contrast-samples')?.remove();
  document.documentElement.dataset.theme = theme;
  const sample = document.createElement('div');
  sample.id = 'contrast-samples';
  sample.style.cssText = 'position:fixed;top:0;left:0;width:240px;z-index:99999;background:var(--page)';
  sample.innerHTML = '<div class="show-page"><div class="show-hero"><span class="show-art show-art-backdrop"></span></div></div>' +
    '<div class="tv-poster"><progress max="2" value="1"></progress></div>' +
    '<div class="sheet personal-sheet"><div class="rating-slider"><progress max="2" value="1"></progress>' +
    '<input type="range" min="0" max="10" value="5" aria-label="Test rating"></div></div>' +
    '<button class="primary">Done</button><button class="destructive">Remove</button>';
  const segments = document.querySelector('main .appearance-options').cloneNode(true);
  for (const radio of segments.querySelectorAll('input')) radio.name = 'contrast-sample';
  sample.append(segments);
  document.body.append(sample);
  const one = selector => sample.querySelector(selector);
  one('.show-hero').style.height = '150px';
  const backdrop = one('.show-art-backdrop');
  backdrop.style.inset = '0';
  backdrop.style.background = art;
  const poster = one('.tv-poster');
  poster.style.height = '60px';
  poster.style.background = art;
  const sheet = one('.sheet');
  sheet.style.background = 'var(--card)';
  one('.primary').focus({preventScroll:true});
  const colours = {};
  const rgb = color => (color.match(/[\d.]+/g) ?? []).slice(0,3).map(Number);
  for (const [name, property, selector] of [
    ['text','color','.show-hero'], ['danger','color','.destructive'], ['dangerFill','backgroundColor','.destructive'],
    ['mainText','color','.primary'], ['mainFill','backgroundColor','.primary'], ['ring','outlineColor','.primary'],
    ['sheet','backgroundColor','.sheet'], ['segment','backgroundColor','.appearance-options input:checked + span'],
    ['segmentText','color','.appearance-options input:checked + span'], ['segmentBase','backgroundColor','.appearance-options'],
  ]) colours[name] = rgb(getComputedStyle(one(selector))[property]);
  const syncLabel = document.createElement('a');
  syncLabel.className = 'sync-state';
  sample.append(syncLabel);
  colours.pendingSync = rgb(getComputedStyle(syncLabel,'::before').backgroundColor);
  syncLabel.dataset.synced = 'true';
  colours.currentSync = rgb(getComputedStyle(syncLabel,'::before').backgroundColor);
  colours.page = rgb(getComputedStyle(sample).backgroundColor);
  const facts = document.createElement('p');
  facts.className = 'show-facts';
  one('.show-hero').append(facts);
  colours.secondary = rgb(getComputedStyle(facts).color);
  const points = {};
  function at(name, selector, x, y, offset = 0) {
    const box = one(selector).getBoundingClientRect();
    points[name] = [Math.floor(box.left + box.width*x + offset), Math.floor(box.top + box.height*y)];
  }
  at('scrim','.show-art-backdrop',0.25,0.5);
  at('filled','.tv-poster progress',0.25,0.5);
  at('track','.tv-poster progress',0.75,0.5);
  at('sliderTrack','.rating-slider input',0.75,0.5);
  at('thumb','.rating-slider input',0.5,0.5);
  // The 24px thumb's 2px border is centred 11 layout pixels from its centre.
  // Bounding rectangles include the app's zoom while offsetHeight is unscaled.
  const slider = one('.rating-slider input');
  const scale = slider.getBoundingClientRect().height / slider.offsetHeight;
  at('thumbRing','.rating-slider input',0.5,0.5,11 * scale);
  return {points,colours};
}

async function pixels(encoded, points) {
  const bytes = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], {type:'image/png'}));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', {willReadFrequently:true});
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return Object.fromEntries(Object.entries(points).map(([name, [x,y]]) =>
    [name, Array.from(context.getImageData(x,y,1,1).data).slice(0,3)]));
}

function luminance(rgb) {
  return rgb.map(channel => channel/255).map(v => v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4)
    .reduce((sum, v, i) => sum + v*[0.2126, 0.7152, 0.0722][i], 0);
}

export function contrastRatio(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
}

export async function checkRenderedContrast(browser) {
  const previous = await browser.evaluate('document.documentElement.getAttribute("data-theme")');
  try {
    for (const theme of ['dark','light']) {
      for (const art of ['white','black']) {
        const {points,colours} = await browser.evaluate('(' + placeSamples + ')(' + JSON.stringify(theme) + ',' + JSON.stringify(art) + ')');
        const {data} = await browser.send('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
        const painted = await browser.evaluate('(' + pixels + ')(' + JSON.stringify(data) + ',' + JSON.stringify(points) + ')');
        const values = {...colours, ...painted};
        for (const [front, back, minimum] of [
          ['text','scrim',4.5], ['secondary','scrim',4.5], ['mainText','mainFill',4.5], ['danger','dangerFill',4.5],
          ['segmentText','segment',4.5], ['segment','segmentBase',3], ['ring','scrim',3],
          ['pendingSync','page',3], ['pendingSync','sheet',3], ['currentSync','page',3], ['currentSync','sheet',3],
          ['filled','track',3], ['sliderTrack','sheet',3], ['thumb','thumbRing',3],
        ]) {
          const ratio = contrastRatio(values[front],values[back]);
          assert.ok(ratio >= minimum, theme + ' over ' + art + ': ' + front + ' on ' + back +
            ' measured ' + ratio.toFixed(2) + ' (' + values[front] + ' on ' + values[back] + ')');
        }
      }
    }
  } finally {
    await browser.evaluate('document.querySelector("#contrast-samples")?.remove()');
    await browser.evaluate(previous === null ? 'document.documentElement.removeAttribute("data-theme")'
      : 'document.documentElement.setAttribute("data-theme",' + JSON.stringify(previous) + ')');
  }
}
