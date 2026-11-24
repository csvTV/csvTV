import { foldListName } from './model.ts';

export const animeClassification = 'Anime';
export const libraryCategories = {all:'All',tv:'TV',anime:'Anime','k-drama':'Korean'} as const;
export type LibraryCategory = keyof typeof libraryCategories;
interface ClassifiedShow {
  lists: readonly string[];
  metadata?: { keywords?: readonly { name: string }[]; originCountries?: readonly string[] } | null;
}

/** AniList's existing classification travels in lists.csv for compatibility with older records. */
export function isAnimeClassification(name: string): boolean {
  return foldListName(name) === 'anime';
}

export function isAnime(show: ClassifiedShow): boolean {
  return show.lists.some(isAnimeClassification) ||
    show.metadata?.keywords?.some(keyword => keyword.name === 'anime') === true;
}

export function matchesLibraryCategory(show: ClassifiedShow, category: LibraryCategory): boolean {
  if (category === 'all') return true;
  if (category === 'anime') return isAnime(show);
  const korean = show.metadata?.originCountries?.includes('KR') === true;
  return category === 'k-drama' ? korean : !!show.metadata && !korean && !isAnime(show);
}
