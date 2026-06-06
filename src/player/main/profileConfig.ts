// Base URL for the Tencent COS bucket hosting player profile indexes and
// avatars (bot-index.json, human-index.json, avatars/<steam64>.jpg).
// Override via COMPET_PROFILE_BASE_URL if the bucket/domain changes.
export const PROFILE_BASE_URL = process.env.COMPET_PROFILE_BASE_URL ?? "https://qwepplz111.site/cos-upload/";
