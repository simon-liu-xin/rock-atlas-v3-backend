export function indexSourceValidation(validation) {
  return {
    musicbrainzArtists: new Map(
      validation.sources.musicbrainz.artists.map((record) => [record.id, record]),
    ),
    musicbrainzReleaseGroups: new Map(
      validation.sources.musicbrainz.release_groups.map((record) => [record.id, record]),
    ),
    discogsArtists: new Map(
      validation.sources.discogs.artists.map((record) => [String(record.id), record]),
    ),
    discogsMasters: new Map(
      validation.sources.discogs.masters.map((record) => [String(record.id), record]),
    ),
  };
}

export function assessRepresentativeValidation({
  selectionBasis,
  artistMusicbrainzMbid,
  releaseMusicbrainzMbid,
  artistDiscogsId,
  releaseDiscogsMasterId,
  indexes,
}) {
  const verifiedSources = selectionBasis === "curated-seed" ? [] : ["wikidata"];
  const conflicts = [];

  const musicbrainz = assessMusicBrainz({
    artistId: artistMusicbrainzMbid,
    releaseGroupId: releaseMusicbrainzMbid,
    artists: indexes.musicbrainzArtists,
    releaseGroups: indexes.musicbrainzReleaseGroups,
  });
  if (musicbrainz.status === "verified") verifiedSources.push("musicbrainz");
  if (musicbrainz.status === "conflicted") conflicts.push(...musicbrainz.conflicts);

  const discogs = assessDiscogs({
    artistId: artistDiscogsId,
    masterId: releaseDiscogsMasterId,
    artists: indexes.discogsArtists,
    masters: indexes.discogsMasters,
  });
  if (discogs.status === "verified") verifiedSources.push("discogs");
  if (discogs.status === "conflicted") conflicts.push(...discogs.conflicts);

  const validationStatus = conflicts.length > 0
    ? "conflicted"
    : selectionBasis === "curated-seed"
    ? "curated"
    : verifiedSources.length >= 2
    ? "cross_verified"
    : "single_source";

  return {
    validation_status: validationStatus,
    verified_sources: verifiedSources,
    musicbrainz_status: musicbrainz.status,
    discogs_status: discogs.status,
    conflicts,
  };
}

function assessMusicBrainz({ artistId, releaseGroupId, artists, releaseGroups }) {
  if (!artistId || !releaseGroupId) return { status: "not_applicable", conflicts: [] };
  const artist = artists.get(artistId);
  const releaseGroup = releaseGroups.get(releaseGroupId);
  if (!artist || !releaseGroup) return { status: "unresolved", conflicts: [] };
  if (!releaseGroup.artist_credit_ids.includes(artistId)) {
    return {
      status: "conflicted",
      conflicts: [`MusicBrainz release-group ${releaseGroupId} does not credit artist ${artistId}.`],
    };
  }
  return { status: "verified", conflicts: [] };
}

function assessDiscogs({ artistId, masterId, artists, masters }) {
  if (!artistId) return { status: "not_applicable", conflicts: [] };
  if (masterId) {
    const master = masters.get(String(masterId));
    if (!master) return { status: "unresolved", conflicts: [] };
    if (!master.artist_ids.map(String).includes(String(artistId))) {
      return {
        status: "conflicted",
        conflicts: [`Discogs master ${masterId} does not credit artist ${artistId}.`],
      };
    }
    return { status: "verified", conflicts: [] };
  }
  return artists.has(String(artistId))
    ? { status: "verified", conflicts: [] }
    : { status: "unresolved", conflicts: [] };
}
