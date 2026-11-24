/** Strip diacritics, then fold case for substring search, including multi-letter forms. */
export function searchText(text: string): string {
  // Lowercase first so that capital ẞ also expands to SS. Uppercase unifies both
  // Greek sigmas. Dotless ı stays distinct from I under Unicode's default folding.
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^ı]+/gu,
    part => part.toLowerCase().toUpperCase());
}
