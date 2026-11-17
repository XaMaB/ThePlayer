interface Choice {
  language: string;
  default: boolean;
  autoselect: boolean;
  forced?: boolean;
}
function languageMatch(language: string, preferred: string) {
  const a = language.toLowerCase(),
    b = preferred.toLowerCase();
  return a === b ? 2 : a.split('-')[0] === b.split('-')[0] ? 1 : 0;
}
/** DEFAULT is a fallback, AUTOSELECT permits environmental matching, not ABR. */
export function selectRendition<T extends Choice>(
  tracks: T[],
  kind: 'audio' | 'subtitles',
  preferences: { language?: string; systemLanguages?: readonly string[] } = {},
): T | undefined {
  if (kind === 'subtitles' && preferences.language === 'off') return;
  const best = (choices: T[], languages: readonly string[]) => {
    for (const language of languages) {
      const sorted = choices
        .map((track) => ({
          track,
          score: languageMatch(track.language, language),
        }))
        .filter((item) => item.score)
        .sort((a, b) => b.score - a.score);
      if (sorted.length) return sorted[0].track;
    }
  };
  // An explicit user language may select a manual-only rendition too.
  if (preferences.language) {
    const requested = best(tracks, [preferences.language]);
    if (requested) return requested;
  }
  const fallback = tracks.find((track) => track.default);
  if (fallback) return fallback;
  const automatic = tracks.filter(
    (track) => track.autoselect && (kind === 'audio' || track.forced),
  );
  const match = best(automatic, preferences.systemLanguages ?? []);
  return match ?? (kind === 'audio' ? automatic[0] : undefined);
}
