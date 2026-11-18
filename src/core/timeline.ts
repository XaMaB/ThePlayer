/** Optional annotations on an engine's primary media timeline. */
export interface TimelineMarker {
  id: string;
  time: number;
  end?: number;
  label: string;
  style: 'highlight' | 'primary';
}
