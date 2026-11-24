// Read the same conditional notices a person can see in Settings.
export async function readCredits(browser) {
  await browser.click('[data-source-credits] summary');
  await browser.waitFor('document.querySelector("[data-source-credits][open]")');
  const text = await browser.evaluate('document.querySelector("[data-source-credits]").innerText');
  await browser.click('[data-source-credits] summary');
  return text;
}
