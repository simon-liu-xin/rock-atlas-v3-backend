export const MUSICBRAINZ_SAMPLE_REQUIRED_MEMBERS = [
  "SCHEMA_SEQUENCE",
  "TIMESTAMP",
  "mbdump/artist",
  "mbdump/artist_type",
  "mbdump/artist_credit",
  "mbdump/artist_credit_name",
  "mbdump/release_group",
  "mbdump/release_group_primary_type",
  "mbdump/release_group_secondary_type",
  "mbdump/release_group_secondary_type_join",
  "mbdump/release",
  "mbdump/release_status",
  "mbdump/release_packaging",
  "mbdump/release_country",
  "mbdump/release_unknown_country",
  "mbdump/iso_3166_1",
  "mbdump/medium",
  "mbdump/medium_format",
  "mbdump/track",
  "mbdump/recording",
  "mbdump/url",
  "mbdump/link",
  "mbdump/link_type",
  "mbdump/l_artist_url",
  "mbdump/l_release_group_url",
  "mbdump/l_release_url",
] as const;

export function validateMusicBrainzSampleMembers(members: string[]): string[] {
  const memberSet = new Set(members);
  const requiredMemberCounts = new Map<string, number>();
  for (const member of members) {
    const segments = member.split("/");
    if (
      member.startsWith("/") ||
      member.includes("\\") ||
      member.includes("\0") ||
      segments.includes("..")
    ) {
      throw new Error(`MusicBrainz archive contains unsafe member path: ${member}`);
    }
    if ((MUSICBRAINZ_SAMPLE_REQUIRED_MEMBERS as readonly string[]).includes(member)) {
      requiredMemberCounts.set(member, (requiredMemberCounts.get(member) ?? 0) + 1);
    }
  }
  for (const requiredMember of MUSICBRAINZ_SAMPLE_REQUIRED_MEMBERS) {
    if (!memberSet.has(requiredMember)) {
      throw new Error(`MusicBrainz archive is missing required member: ${requiredMember}`);
    }
    if (requiredMemberCounts.get(requiredMember) !== 1) {
      throw new Error(`MusicBrainz archive contains duplicate required member: ${requiredMember}`);
    }
  }
  return [...MUSICBRAINZ_SAMPLE_REQUIRED_MEMBERS];
}
