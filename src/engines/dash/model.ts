import type { Resource } from '../hls/playlist';
export interface TimelineEntry {
  time?: bigint;
  duration: bigint;
  repeat: number;
}
export interface SegmentAddress {
  kind: 'template' | 'list' | 'base';
  timescale: number;
  presentationTimeOffset: bigint;
  startNumber: bigint;
  eptDelta: bigint;
  duration?: bigint;
  media?: string;
  initialization?: string;
  initializationRange?: { offset: number; length: number };
  indexRange?: { offset: number; length: number };
  timeline?: TimelineEntry[];
  urls?: { media: string; range?: { offset: number; length: number } }[];
  availabilityTimeOffset: number;
  availabilityTimeComplete: boolean;
}
export interface Protection {
  scheme: string;
  value?: string;
  keyIds: string[];
  pssh: Uint8Array[];
}
export interface ProducerReference {
  id: string;
  type: 'encoder' | 'captured' | 'application';
  inband: boolean;
  wallClockTime: number;
  presentationTime: bigint;
}
export interface Representation {
  id: string;
  bandwidth: number;
  codecs: string;
  mimeType: string;
  width?: number;
  height?: number;
  frameRate?: number;
  channels?: { scheme: string; value: string };
  tiles?: { columns: number; rows: number };
  baseUrls: string[];
  serviceLocations?: string[];
  address: SegmentAddress;
  protection: Protection[];
  producerReferences?: ProducerReference[];
}
export interface Adaptation {
  id: string;
  kind: 'video' | 'audio' | 'text' | 'image';
  language: string;
  label: string;
  roles: string[];
  accessibility?: { scheme: string; value: string }[];
  representations: Representation[];
}
export interface DashEvent {
  type: 'dash-event';
  scheme: string;
  value: string;
  id: string;
  time: number;
  duration?: number;
  data: string;
}
export interface Period {
  id: string;
  start: number;
  duration?: number;
  adaptations: Adaptation[];
  remote?: boolean;
  events?: DashEvent[];
}
export interface Manifest {
  url: string;
  id: string;
  live: boolean;
  duration?: number;
  minBufferTime: number;
  minimumUpdatePeriod?: number;
  availabilityStartTime?: number;
  publishTime?: number;
  timeShiftBufferDepth?: number;
  suggestedPresentationDelay?: number;
  service?: {
    targetLatency: number;
    referenceId?: string;
    minLatency?: number;
    maxLatency?: number;
    minRate: number;
    maxRate: number;
  };
  utcTiming: { scheme: string; value: string }[];
  locations: string[];
  locationServices?: string[];
  steering?: { url: string; defaults: string[]; queryBeforeStart: boolean };
  patchLocations?: { url: string; ttl?: number }[];
  periods: Period[];
}
export interface SegmentReference extends Resource {
  telemetry?: import('./telemetry').MediaRequest;
  alternatives?: string[];
  serviceLocations?: string[];
  number: bigint;
  time: bigint;
  start: number;
  end: number;
}
