export type SourceValidationState = "verified" | "unresolved" | "conflicted" | "not_applicable";
export type RepresentativeValidationStatus =
  | "cross_verified"
  | "single_source"
  | "curated"
  | "conflicted";

export interface SourceValidationDocument {
  sources: {
    musicbrainz: {
      artists: Array<{ id: string }>;
      release_groups: Array<{ id: string; artist_credit_ids?: string[] }>;
    };
    discogs: {
      artists: Array<{ id: string | number }>;
      masters: Array<{ id: string | number; artist_ids?: Array<string | number> }>;
    };
  };
}

export interface SourceValidationIndexes {
  musicbrainzArtists: Map<string, { id: string }>;
  musicbrainzReleaseGroups: Map<string, { id: string; artist_credit_ids?: string[] }>;
  discogsArtists: Map<string, { id: string | number }>;
  discogsMasters: Map<string, { id: string | number; artist_ids?: Array<string | number> }>;
}

export interface RepresentativeValidation {
  validation_status: RepresentativeValidationStatus;
  verified_sources: string[];
  musicbrainz_status: SourceValidationState;
  discogs_status: SourceValidationState;
  conflicts: string[];
}

export function indexSourceValidation(document: SourceValidationDocument): SourceValidationIndexes;

export function assessRepresentativeValidation(options: {
  selectionBasis: "curated-seed" | "wikidata-direct-genre" | "wikidata-ancestor-fallback";
  artistMusicbrainzMbid: string | null;
  releaseMusicbrainzMbid: string | null;
  artistDiscogsId: string | null;
  releaseDiscogsMasterId: string | null;
  indexes: SourceValidationIndexes;
}): RepresentativeValidation;
